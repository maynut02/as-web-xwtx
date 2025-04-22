<template>
  <el-empty :description="desc" style="height: 100%" />
</template>

<script setup lang="ts">
withDefaults(defineProps<{ desc: string }>(), { desc: '프리뷰 없음' });
</script>
