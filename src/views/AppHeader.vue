<template>
  <div class="menu-bar">
    <MenuBar :config="menuConfig">
      <template #right>
        <el-button class="github-btn" :icon="IconGithub" circle text @click="gotoGithub" />
      </template>
    </MenuBar>
    <ExportOptionsDialog ref="exportOptionsDialogRef" />
    <UnityCNOptionsDialog ref="unityCNOptionsDialogRef" />
  </div>
</template>

<script setup lang="ts">
import { BundleEnv } from '@arkntools/unity-js';
import { useFileDialog } from '@vueuse/core';
import IElSelect from '~icons/ep/select';
import IconGithub from '@/assets/github.svg';
import MenuBar from '@/components/MenuBar.vue';
import type { MenuBarConfig } from '@/components/MenuBar.vue';
import type { MenuDropdownConfigItem } from '@/components/MenuDropdown.vue';
import { BundleEnvIndex } from '@/constants/bundle-env';
import { useAssetManager } from '@/store/assetManager';
import { useSetting } from '@/store/setting';
import ExportOptionsDialog from './components/ExportOptionsDialog.vue';
import UnityCNOptionsDialog from './components/UnityCNOptionsDialog.vue';

const emits = defineEmits<{
  (name: 'commandExport', type: string): any;
}>();

const assetManager = useAssetManager();
const setting = useSetting();

const exportOptionsDialogRef = ref<InstanceType<typeof ExportOptionsDialog>>();
const unityCNOptionsDialogRef = ref<InstanceType<typeof UnityCNOptionsDialog>>();

const gotoGithub = () => {
  window.open('https://github.com/arkntools/as-web', '_blank');
};

const loadFiles = (list: FileList | null) => {
  if (!list || !list.length) return;
  assetManager.loadFiles([...list]);
};

const { open: openFile, onChange: onFileChange } = useFileDialog({ reset: true });
onFileChange(loadFiles);

const { open: openFolder, onChange: onFolderChange } = useFileDialog({ directory: true, reset: true });
onFolderChange(loadFiles);

const getEnvMenuItem = (
  name: string,
  value: (typeof setting.data)['unityEnv'],
  index: number,
  divided?: boolean,
): MenuDropdownConfigItem => ({
  name,
  divided,
  handler: () => {
    setting.data.unityEnv = value;
    setting.data.unityEnvIndex = index;
  },
  icon: () => (setting.data.unityEnvIndex === index ? IElSelect : undefined),
});

const menuConfig = markRaw<MenuBarConfig>([
  {
    name: '파일',
    items: [
      {
        name: '파일 불러오기',
        handler: openFile,
        disabled: () => assetManager.isLoading,
      },
      {
        name: '폴더 불러오기',
        handler: openFolder,
        disabled: () => assetManager.isLoading,
      },
    ],
  },
  {
    name: '설정',
    icon: true,
    items: [
      {
        name: '프리뷰 활성화',
        handler: () => {
          setting.data.enablePreview = !setting.data.enablePreview;
        },
        icon: () => (setting.data.enablePreview ? IElSelect : undefined),
      },
      {
        name: '내보내기 옵션',
        divided: true,
        handler: () => {
          exportOptionsDialogRef.value?.open();
        },
      },
      {
        name: 'UnityCN 옵션',
        handler: () => {
          unityCNOptionsDialogRef.value?.open();
        },
      },
    ],
  },
  {
    name: '환경',
    icon: true,
    items: [
      getEnvMenuItem('없음', BundleEnv.NONE, 0),
      getEnvMenuItem('Arknights', BundleEnv.ARKNIGHTS, 1, true),
      getEnvMenuItem('신월동행', BundleEnv.NONE, 2),
    ],
  },
  {
    name: '내보내기',
    items: [
      {
        name: '모든 에셋',
        handler: () => emits('commandExport', 'all'),
        disabled: () => !assetManager.assetInfos.length,
      },
      {
        name: '필터링된 에셋',
        handler: () => emits('commandExport', 'filtered'),
        disabled: () => !assetManager.assetInfos.length,
      },
      {
        name: '선택된 에셋',
        handler: () => emits('commandExport', 'selected'),
        disabled: () => !(assetManager.assetInfos.length && assetManager.curAssetInfo),
      },
    ],
  },
]);
</script>

<style lang="scss" scoped>
.menu-btn {
  border: none;
  border-radius: 0;
  outline: none;
}

.github-btn {
  --el-fill-color-light: rgba(0, 0, 0, 0.1);
  --el-fill-color: rgba(0, 0, 0, 0.15);
  padding: 4px;
  font-size: 18px;
}
</style>
