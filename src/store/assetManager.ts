import { proxy } from 'comlink';
import { saveAs } from 'file-saver';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { getDateString } from '@/utils/date';
import { showNotingCanBeExportToast } from '@/utils/toasts';
import type { AssetInfo, ExportAssetsOnProgress, FileLoadingOnProgress } from '@/workers/assetManager';
import { useProgress } from './progress';
import type { ProgressData } from './progress';
import { useSetting } from './setting';

const worker = new ComlinkWorker<typeof import('@/workers/assetManager')>(
  new URL('../workers/assetManager.js', import.meta.url),
);
const manager = new worker.AssetManager();

export const useAssetManager = defineStore('assetManager', () => {
  const progressStore = useProgress();
  const setting = useSetting();

  const assetInfos = ref<AssetInfo[]>([]);
  const isLoading = ref(false);
  const curAssetInfo = ref<AssetInfo>();

  const assetInfoMap = computed(() => new Map(assetInfos.value.map(info => [info.key, info])));

  const canExportAssetType = new Set<string>();

  manager
    .then(m => m.getCanExportAssetTypes())
    .then(types => {
      types.forEach(type => {
        canExportAssetType.add(type);
      });
    })
    .catch(console.error);

  const canExport = ({ type }: Pick<AssetInfo, 'type'>) => canExportAssetType.has(type);

  const onProgress = proxy<FileLoadingOnProgress>(({ name, progress, totalAssetNum }) => {
    progressStore.setProgress({
      type: 'loading',
      value: progress,
      desc: `${name} 로딩중, 전체 에셋: ${totalAssetNum}`,
    });
  });

  const loadFiles = async (files: File[]) => {
    isLoading.value = true;
    try {
      console.log(setting);
      const { errors, infos, successNum } = await (
        await manager
      ).loadFiles(
        files,
        {
          unityCNKey: setting.unityCNKey,
          env: setting.data.unityEnv,
          envIndex: setting.data.unityEnvIndex,
        },
        onProgress,
      );
      infos.forEach(({ dump }) => {
        markRaw(dump);
      });
      if (infos.length) {
        assetInfos.value = infos;
        curAssetInfo.value = undefined;
        ElMessage({
          message: `${successNum}개의 파일에서 ${infos.length}개의 에셋을 불러왔습니다`,
          type: 'success',
        });
      }
      if (files.length === 1 && errors.length) {
        errors.forEach(({ name, error }) => {
          ElMessage({
            message: `${name} 불러오기 실패 : ${error}`,
            type: 'error',
          });
        });
      }
    } catch (error) {
      ElMessage({
        message: `불러오기 실패 : ${error}`,
        type: 'error',
      });
    } finally {
      isLoading.value = false;
      progressStore.clearProgress();
    }
  };

  const clearFiles = async () => {
    assetInfos.value = [];
    await (await manager).clear();
  };

  const loadImage = async ({ key, fileId, pathId }: Pick<AssetInfo, 'key' | 'fileId' | 'pathId'>) => {
    const img = await (await manager).getImageUrl(fileId, pathId);
    assetInfoMap.value.get(key)!.data = img ?? null;
  };

  const setCurAssetInfo = (info: AssetInfo) => {
    curAssetInfo.value = info;
  };

  const exportAsset = async ({ name, fileId, pathId, type }: AssetInfo) => {
    if (!canExport({ type })) {
      showNotingCanBeExportToast();
      return;
    }
    const file = await (await manager).exportAsset(fileId, pathId);
    if (!file) {
      ElMessage({
        message: `${name} 내보내기 실패`,
        type: 'error',
        grouping: true,
      });
      return;
    }
    saveAs(new Blob([file.data], { type: file.type }), file.name);
  };

  const isBatchExporting = ref(false);

  const batchExportOnProgress = proxy<ExportAssetsOnProgress>(({ type, percent, name }) => {
    const data: Partial<ProgressData> = {};
    switch (type) {
      case 'exportPreparing':
        data.value = percent * 0.45;
        data.desc = `Preparing ${name}`;
        break;
      case 'exportAsset':
        data.value = 45 + percent * 0.5;
        data.desc = `Exporting ${name}`;
        break;
      case 'exportZip':
        data.value = 95 + percent * 0.05;
        data.desc = `Packing ${name}`;
        break;
    }
    progressStore.setProgress(data);
  });

  const batchExportAsset = async (infos: AssetInfo[]) => {
    if (isBatchExporting.value) return;
    isBatchExporting.value = true;
    progressStore.setProgress({
      type: 'export',
      desc: 'Preparing',
    });
    try {
      const zip = await (
        await manager
      ).exportAssets(
        infos.map(({ fileId, pathId, fileName, container }) => ({ fileId, pathId, fileName, container })),
        { groupMethod: setting.data.exportGroupMethod },
        batchExportOnProgress,
      );
      progressStore.setProgress({
        value: 100,
        desc: '',
      });
      saveAs(new Blob([zip], { type: 'application/zip' }), `assets-export-${getDateString()}.zip`);
    } catch (error) {
      console.error(error);
    } finally {
      isBatchExporting.value = false;
      progressStore.clearProgress();
    }
  };

  const exportAllAssets = async () => {
    const canExportAssets = assetInfos.value.filter(canExport);
    if (!canExportAssets.length) {
      showNotingCanBeExportToast();
      return;
    }
    await batchExportAsset(assetInfos.value);
  };

  return {
    assetInfos,
    assetInfoMap,
    curAssetInfo,
    isLoading,
    isBatchExporting,
    loadFiles,
    clearFiles,
    loadImage,
    setCurAssetInfo,
    exportAsset,
    batchExportAsset,
    exportAllAssets,
    canExport,
  };
});
