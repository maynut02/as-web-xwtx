import { AssetType, loadAssetBundle } from '@arkntools/unity-js';
import type {
  AssetObject,
  Bundle,
  BundleLoadOptions,
  ImgBitMap,
  Sprite,
  TextAsset,
  Texture2D,
} from '@arkntools/unity-js';
import { proxy, releaseProxy, transfer } from 'comlink';
import { md5 as calcMd5 } from 'js-md5';
import type { OnUpdateCallback } from 'jszip';
import { ExportGroupMethod } from '@/types/export';
import { toTrackedPromise } from '@/utils/trackedPromise';
import type { TrackedPromise } from '@/utils/trackedPromise';
import { ImageConverterPool } from './utils/imageConverterPool';

export async function digestSha1(
  data: ArrayBuffer | Uint8Array
): Promise<Uint8Array> {
  const buf = data instanceof ArrayBuffer ? data : data.buffer;
  const hashBuffer = await crypto.subtle.digest('SHA-1', buf);
  return new Uint8Array(hashBuffer);
}

export async function getKeyPbkdf1(
  password: string,
  salt: Uint8Array,
  keyLen: number,
  countParam: number
): Promise<Uint8Array> {
  let index = 1;
  const count = countParam - 1;

  // 1) 초기 해시: SHA1(password || salt)
  const pwdBytes = new TextEncoder().encode(password);
  let hash = await digestSha1(new Uint8Array([...pwdBytes, ...salt]));

  // 2) (countParam‑1)회 추가 해싱
  for (let i = 0; i < count - 1; i++) {
    hash = await digestSha1(hash);
  }

  // 3) hashder = SHA1(hash)
  let hashder = await digestSha1(hash);

  // 4) keyLen 바이트가 될 때까지 확장
  while (hashder.length < keyLen) {
    const marker = index + 48;
    const extra = await digestSha1(new Uint8Array([marker, ...hash]));
    hashder = new Uint8Array([...hashder, ...extra]);
    index++;
  }

  return hashder.slice(0, keyLen);
}

export async function decryptAesCtrPbkdf1(
  data: Uint8Array,
  password: string,
  salt: Uint8Array,
  keyLen = 32,
  countParam = 100
): Promise<Uint8Array> {
  // 1) PBKDF1‑SHA1 으로 암호화 키 도출
  const keyBytes = await getKeyPbkdf1(password, salt, keyLen, countParam);

  // 2) AES-CBC 알고리즘으로 import
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer,
    'AES-CBC',
    false,
    ['encrypt']
  );
  const zeroIV = new Uint8Array(16);

  const BLOCK_SIZE = 16;
  const output = new Uint8Array(data.length);
  let counter = 1n;

  // 3) 블록 단위로 keystream 생성 후 XOR
  for (let offset = 0; offset < data.length; offset += BLOCK_SIZE) {
    // 3-1) C#/Python과 동일한 LE 64비트 카운터 + 64비트 zero
    const counterBlock = new Uint8Array(16);
    new DataView(counterBlock.buffer).setBigUint64(0, counter, true);

    // 3-2) ECB 암호화 (AES‑CBC + zeroIV 에서 첫 블록만 encrypt)
    const keystreamBuf = await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: zeroIV },
      cryptoKey,
      counterBlock.buffer
    );
    const keystream = new Uint8Array(keystreamBuf).subarray(0, BLOCK_SIZE);

    // 3-3) 암호문 + keystream → 평문
    const chunkLen = Math.min(BLOCK_SIZE, data.length - offset);
    for (let i = 0; i < chunkLen; i++) {
      output[offset + i] = data[offset + i] ^ keystream[i];
    }

    counter++;
  }

  return output;
}

export interface AssetInfo {
  key: string;
  fileId: string;
  fileName: string;
  name: string;
  container: string;
  type: string;
  pathId: bigint;
  size: number;
  dump: Record<string, any>;
  /** `undefined` means not loaded, `null` means error */
  data: string | null | undefined;
  search: string;
}

export interface FileLoadingError {
  name: string;
  error: string;
}

export type FileLoadingOnProgress = (param: { name: string; progress: number; totalAssetNum: number }) => any;

export type ExportAssetsOnProgress = (param: {
  type: 'exportPreparing' | 'exportAsset' | 'exportZip';
  percent: number;
  name: string;
}) => any;

type ZipModule = typeof import('./zip');

const showAssetType = new Set([AssetType.TextAsset, AssetType.Sprite, AssetType.SpriteAtlas, AssetType.Texture2D]);
const canExportAssetType = new Set([AssetType.TextAsset, AssetType.Sprite, AssetType.Texture2D]);
const isTextAssetObj = (obj?: AssetObject): obj is TextAsset => obj?.type === AssetType.TextAsset;
const isImageAssetObj = (obj?: AssetObject): obj is Sprite | Texture2D =>
  !!obj && (obj.type === AssetType.Sprite || obj.type === AssetType.Texture2D);

const getLegalFileName = (name: string) => name.replace(/[/\\:*?"<>|]/g, '');

export class AssetManager {
  private bundleMap = new Map<string, Bundle>();
  private imageMap = new Map<string, TrackedPromise<{ url: string; blob: Blob } | undefined>>();
  private textDecoder = new TextDecoder('utf-8');
  private imageConverter = new ImageConverterPool();
  private _zipWorker!: InstanceType<typeof ComlinkWorker<ZipModule>>;

  private get zipWorker() {
    if (this._zipWorker) return this._zipWorker;
    const worker = new ComlinkWorker<ZipModule>(new URL('./zip.js', import.meta.url));
    this._zipWorker = worker;
    return worker;
  }

  clear() {
    this.bundleMap.clear();
    this.imageMap.forEach(async img => {
      const url = (await img)?.url;
      if (url) URL.revokeObjectURL(url);
    });
    this.imageMap.clear();
  }

  getCanExportAssetTypes() {
    return [...canExportAssetType.values()].map(type => AssetType[type]);
  }

  async loadFiles(
    files: File[],
    options: BundleLoadOptions,
    onProgress: FileLoadingOnProgress
  ) {
    const errors: FileLoadingError[] = [];
    const infos: AssetInfo[] = [];
    let successNum = 0;

    for (let i = 0; i < files.length; i++) {
      let file = files[i];
      try {
        onProgress({
          name: file.name,
          progress: (i / files.length) * 100,
          totalAssetNum: infos.length,
        });

        // envIndex === 2(신월동행) 수동 CTR 복호화
        if (options.envIndex === 2 && file.name.endsWith('.ab')) {
          const raw = new Uint8Array(await file.arrayBuffer());
          const salt = new TextEncoder().encode(
            file.name.replace(/\.ab$/, '')
          );
  
          const decrypted = await decryptAesCtrPbkdf1(
            raw,
            'System.Byte[]',
            salt,
            32,
            100
          );
  
          file = new File([decrypted], file.name, { type: file.type });
        }
        
        const result = await this.loadFile(file, options);
        if (result.length) {
          successNum++;
          infos.push(...result);
        }
      } catch (err) {
        errors.push({ name: file.name, error: String(err) });
      }
    }

    return { errors, infos, successNum };
  }

  async getImageUrl(fileId: string, pathId: bigint) {
    return (await this.loadImage(fileId, pathId))?.url;
  }

  async exportAsset(fileId: string, pathId: bigint) {
    const obj = this.getAssetObj(fileId, pathId);
    if (!obj || !canExportAssetType.has(obj.type)) return;
    const fileName = getLegalFileName(obj.name);
    switch (obj.type) {
      case AssetType.TextAsset:
        return {
          name: `${fileName}.txt`,
          type: 'text/plain',
          data: obj.data,
        };
      case AssetType.Sprite:
      case AssetType.Texture2D: {
        const buffer = await (await this.loadImage(fileId, pathId))?.blob.arrayBuffer();
        if (buffer) {
          return transfer(
            {
              name: `${fileName}.png`,
              type: 'image/png',
              data: buffer,
            },
            [buffer],
          );
        }
      }
    }
  }

  async exportAssets(
    params: Array<{ fileId: string; pathId: bigint; fileName: string; container: string }>,
    { groupMethod }: { groupMethod: ExportGroupMethod },
    onProgress: ExportAssetsOnProgress,
  ) {
    const zip = await new this.zipWorker.Zip();
    const objMap = new Map(
      params.map(({ fileId, pathId, fileName, container }) => {
        const key = this.getAssetKey(fileId, pathId);
        return [key, { key, fileName, container, obj: this.getAssetObj(fileId, pathId) }];
      }),
    );
    const getObjName = (key: string) => objMap.get(key)?.obj?.name ?? '';
    const getObjPath = (key: string, ext: string) => {
      const data = objMap.get(key);
      if (!data?.obj) return '';
      const { obj, fileName, container } = data;
      const legalName = getLegalFileName(obj.name);
      switch (groupMethod) {
        case ExportGroupMethod.CONTAINER_PATH:
          if (container) return container;
        // eslint-disable-next-line no-fallthrough
        case ExportGroupMethod.NONE:
          return `${legalName}.${ext}`;
        case ExportGroupMethod.TYPE_NAME:
          return `${AssetType[obj.type]}/${legalName}.${ext}`;
        case ExportGroupMethod.SOURCE_FILE_NAME:
          return `${fileName}/${legalName}.${ext}`;
      }
    };

    const objs = [...objMap.values()];
    const textObjs = objs.filter(obj => isTextAssetObj(obj.obj));

    const imgData: Array<{ key: string; blob: Blob }> = [];
    const imgBitmaps: Array<{ key: string; bitmap: ImgBitMap }> = [];
    let lastPrepareUpdateTs = 0;

    const imgObjs = objs.filter(({ obj }) => isImageAssetObj(obj)) as Array<{
      key: string;
      obj: Texture2D | Sprite;
    }>;
    const updatePrepareProgress = (i: number, key: string) => {
      const now = Date.now();
      if (now - lastPrepareUpdateTs < 50) return;
      lastPrepareUpdateTs = now;
      onProgress({ type: 'exportPreparing', percent: (i / imgObjs.length) * 100, name: getObjName(key) });
    };
    for (const [i, { key, obj }] of imgObjs.entries()) {
      updatePrepareProgress(i, obj.name);
      const image = this.imageMap.get(key);
      if (image?.isFulfilled()) {
        const blob = (await image)?.blob;
        if (blob) {
          imgData.push({ key, blob });
          continue;
        }
      }
      const bitmap = obj.getImageBitmap();
      if (bitmap) {
        imgBitmaps.push({ key, bitmap });
      }
    }

    const total = imgData.length + imgBitmaps.length + (textObjs.length ? 1 : 0);
    let complete = 0;

    const imageConvertPromise = imgBitmaps.length
      ? this.imageConverter.addTasks(imgBitmaps, ({ key, data }) => {
          zip.add(transfer({ name: getObjPath(key, 'png'), data }, [data]));
          onProgress({ type: 'exportAsset', percent: (++complete / total) * 100, name: getObjName(key) });
        })
      : null;
    if (imgData.length) {
      await Promise.allSettled(
        imgData.map(async ({ key, blob }) => {
          zip.add({ name: getObjPath(key, 'png'), data: await blob.arrayBuffer() });
        }),
      );
      complete += imgData.length;
      onProgress({ type: 'exportAsset', percent: (complete / total) * 100, name: `${imgData.length} cached images` });
    }
    if (textObjs.length) {
      textObjs.forEach(({ key, obj }) => {
        zip.add({ name: getObjPath(key, 'txt'), data: (obj as TextAsset).data });
      });
      onProgress({ type: 'exportAsset', percent: (++complete / total) * 100, name: `${textObjs.length} TextAsset` });
    }

    await imageConvertPromise;

    const buffer = await zip.generate(
      undefined,
      proxy<OnUpdateCallback>(({ percent, currentFile }) => {
        onProgress({ type: 'exportZip', percent, name: currentFile || '' });
      }),
    );
    zip[releaseProxy]();

    return transfer(buffer, [buffer]);
  }

  private getAssetObj(fileId: string, pathId: bigint) {
    return this.bundleMap.get(fileId)?.objectMap.get(pathId);
  }

  private async loadImage(fileId: string, pathId: bigint) {
    const key = this.getAssetKey(fileId, pathId);
    if (this.imageMap.has(key)) return this.imageMap.get(key);

    const obj = this.getAssetObj(fileId, pathId);
    if (!obj || (obj.type !== AssetType.Sprite && obj.type !== AssetType.Texture2D)) return;

    const result = (async () => {
      const timeLabel = `[AssetManager] load image ${obj.name}`;
      console.time(timeLabel);
      const buffer = await this.getAssetObjPNG(obj);
      console.timeEnd(timeLabel);
      if (!buffer) return;

      const blob = new Blob([buffer], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      return { blob, url };
    })();

    this.imageMap.set(key, toTrackedPromise(result));

    return result;
  }

  private async getAssetObjPNG(obj: { getImageBitmap: () => ImgBitMap | undefined }) {
    const bitmap = obj.getImageBitmap();
    if (!bitmap) return;
    let buffer: ArrayBuffer | undefined;
    await this.imageConverter.addTasks([{ key: '', bitmap }], ({ data }) => {
      buffer = data;
    });
    if (buffer) return buffer;
  }

  private async loadFile(file: File, options?: BundleLoadOptions) {
    const buffer = await file.arrayBuffer();
    const md5 = calcMd5(buffer);

    const fileInfo = { fileId: md5, fileName: file.name };
    const bundle = this.bundleMap.get(md5) ?? (await loadAssetBundle(buffer, options));
    if (!this.bundleMap.has(md5)) this.bundleMap.set(md5, bundle);

    return Promise.all(
      bundle.objects
        .filter(obj => showAssetType.has(obj.type))
        .map(async (obj): Promise<AssetInfo> => {
          const { name, type, pathId, size } = obj;
          const key = this.getAssetKey(fileInfo.fileId, pathId);
          const container = bundle.containerMap?.get(pathId) ?? '';
          return {
            ...fileInfo,
            key,
            name,
            container,
            type: AssetType[type] ?? '',
            pathId,
            size,
            dump: obj.dump(),
            data: await this.getAssetData(obj, key),
            search: name.toLowerCase(),
          };
        }),
    );
  }

  private async getAssetData(obj: AssetObject, key: string) {
    try {
      switch (obj.type) {
        case AssetType.TextAsset:
          return this.textDecoder.decode(obj.data);
        case AssetType.Sprite:
        case AssetType.Texture2D: {
          const imgPromise = this.imageMap.get(key);
          if (imgPromise?.isFulfilled()) {
            return (await imgPromise)?.url ?? null;
          }
          break;
        }
      }
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  private getAssetKey(fileId: string, pathId: bigint) {
    return `${fileId}_${pathId}`;
  }
}