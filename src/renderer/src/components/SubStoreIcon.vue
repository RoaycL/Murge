<script setup lang="ts">
/**
 * Monochrome Vue adaptation of Sub-Store's official mark.
 * Source: https://github.com/sub-store-org/Sub-Store-Front-End/blob/master/public/favicon.svg
 * License: GPL-3.0
 */
defineProps<{ size?: number }>()
</script>

<template>
  <svg
    :width="size ?? 18"
    :height="size ?? 18"
    viewBox="14 14 80 80"
    aria-hidden="true"
    class="sub-store-icon"
  >
    <path
      fill="currentColor"
      transform="translate(39.809 35.032) scale(-1 1) rotate(-360) translate(-39.809 -35.032)"
      d="M57.718 39.212c3.4-10.3-6.5-20.6-16.8-17.5-2.6.8-6.4 3.8-11.8 9.2l-7.9 8 4.4 4.4 7.8-7.7c6.4-6.4 8.3-7.7 11-7.7 7.2 0 9.7 8.2 4.2 13.5l-3 2.9 4.4 4.6 3.3-3.2c1.8-1.7 3.8-4.7 4.4-6.5Z"
    />
    <path fill="currentColor" transform="translate(41.95 54.25) scale(-1 1) rotate(-180) translate(-41.95 -54.25)" d="m49.4 60.392-5.8-5.892 5.8-6-4.4-4.5-10.5 10.5 10.6 10c.2 0 1.633-1.369 4.3-4.108Z" />
    <path fill="currentColor" transform="translate(65.85 54.25) rotate(-180) translate(-65.85 -54.25)" d="m73.3 60.392-5.8-5.892 5.8-6-4.4-4.5-10.5 10.5 10.6 10c.2 0 1.633-1.369 4.3-4.108Z" />
    <path fill="currentColor" transform="translate(35.146 72.88) scale(-1 1) rotate(-180) translate(-35.146 -72.88)" d="M31 79.061c-3.5-4-3.9-8.4-1-11.3 3.1-3.1 8-2.6 11.5 1l2.9 3 4.6-4.4-3.2-3.3c-6.2-6.4-14.3-6.8-20.2-.8-6 5.9-5.7 13.6.7 20.2l3.1 3.3 4.5-4.3-2.9-3.4Z" />
    <path fill="currentColor" transform="translate(72.854 35.031) scale(-1 1) rotate(-360) translate(-72.854 -35.031)" d="M68.708 41.212c-3.5-4-3.9-8.4-1-11.3 3.1-3.1 8-2.6 11.5 1l2.9 3 4.6-4.4-3.2-3.3c-6.2-6.4-14.3-6.8-20.2-.8-6 5.9-5.7 13.6.7 20.2l3.1 3.3 4.5-4.3-2.9-3.4Z" />
    <path fill="currentColor" transform="translate(68.191 72.88) scale(-1 1) rotate(-180) translate(-68.191 -72.88)" d="M86.1 77.061c3.4-10.3-6.5-20.6-16.8-17.5-2.6.8-6.4 3.8-11.8 9.2l-7.9 8 4.4 4.4 7.8-7.7c6.4-6.4 8.3-7.7 11-7.7 7.2 0 9.7 8.2 4.2 13.5l-3 2.9 4.4 4.6 3.3-3.2c1.8-1.7 3.8-4.7 4.4-6.5Z" />
  </svg>
</template>

<style scoped>
.sub-store-icon { display: block; flex: none; }
</style>
