---
name: vue
description: Vue 3 + TypeScript specifics (reactivity, composables, lifecycle)
model: sonnet
category: bug
---
Review only Vue/TypeScript-specific problems in the changed `.vue` and `.ts` files:

- lost reactivity: destructuring `props`/`reactive()` without `toRefs`, replacing a `reactive` object, `ref` used without `.value` in script;
- `watch`/`watchEffect` that never fire or fire in a loop, missing `immediate`/`deep` where the code clearly relies on it;
- side effects and listeners in `onMounted` without cleanup in `onUnmounted`;
- composables called outside `setup()` or conditionally;
- `v-for` without a stable `:key`, `v-if` together with `v-for` on the same element;
- `v-html` with user-controlled content;
- props mutated directly, emits not declared.

Skip anything that is only style.
