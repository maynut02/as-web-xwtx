<template>
  <el-dialog v-model="show" title="내보내기 옵션" width="min(500px, calc(100vw - 16px))">
    <el-form label-width="auto" label-position="top">
      <el-form-item label="내보낼 에셋 그룹화 방법">
        <el-select v-model="setting.data.exportGroupMethod" :style="{ width: '200px' }">
          <el-option v-for="{ label, value } in exportGroupMethodOptions" :key="value" :label="label" :value="value" />
        </el-select>
      </el-form-item>
    </el-form>
  </el-dialog>
</template>

<script setup lang="ts">
import { useSetting } from '@/store/setting';
import { ExportGroupMethod } from '@/types/export';

const setting = useSetting();

const show = ref(false);

const exportGroupMethodOptions: Array<{ label: string; value: ExportGroupMethod }> = [
  {
    label: '그룹화 하지 않음',
    value: ExportGroupMethod.NONE,
  },
  {
    label: '타입 이름',
    value: ExportGroupMethod.TYPE_NAME,
  },
  {
    label: '소스 파일 이름',
    value: ExportGroupMethod.SOURCE_FILE_NAME,
  },
  {
    label: 'container 경로',
    value: ExportGroupMethod.CONTAINER_PATH,
  },
];

defineExpose({
  open: () => {
    show.value = true;
  },
});
</script>
