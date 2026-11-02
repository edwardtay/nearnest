import { Buffer } from 'buffer';
globalThis.Buffer ??= Buffer;
globalThis.process ??= { env: {}, browser: true, version: '', versions: {}, nextTick: (f, ...a) => queueMicrotask(() => f(...a)) };
