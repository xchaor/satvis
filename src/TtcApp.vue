<template>
  <UApp :toaster="{ position: 'bottom-right' }">
    <control-center-panel />
  </UApp>
</template>

<script setup lang="ts">
import ControlCenterPanel from "@/components/control/ControlCenterPanel.vue";
</script>
