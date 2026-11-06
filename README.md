# tiny-mock-fs-stub

An in-memory filesystem stub that implements the synchronous subset of Node's `fs` API, for testing file-handling code without touching the real disk.

```js
import { createMemoryFileSystem } from 'tiny-mock-fs-stub';

const fs = createMemoryFileSystem();

fs.mkdirSync('/data', { recursive: true });
fs.writeFileSync('/data/config.json', '{"ok":true}');

const text = fs.readFileSync('/data/config.json', 'utf8');
console.log(text); // {"ok":true}

const fd = fs.openSync('/data/log.txt', 'a');
fs.writeSync(fd, Buffer.from('first line\n'));
fs.closeSync(fd);

console.log(fs.readdirSync('/data')); // [ 'config.json', 'log.txt' ]
```

## Why this exists

Tests that exercise file operations usually reach for `memfs` or write into a temporary directory. Both options have costs: a third-party dependency pulls in a large surface area, and a real temporary directory is slow, leaks state between tests, and fails in sandboxes that disallow writes. This library keeps the surface area deliberately small. It implements the synchronous `fs` calls that most file-handling code actually uses, with the same error codes (`ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `EINVAL`, `EBADF`, `EACCES`) that Node throws, so callers can keep their existing `try`/`catch` logic.

The trade-off is scope. This is not a drop-in replacement for `fs`. There are no asynchronous methods, no streams, no `fs.promises`, and no file watching. Timestamps are fixed at the epoch because the stub is meant to be deterministic: a test that depends on `mtime` should use a real clock, not a fake one. If your code needs those things, use a fuller implementation.

## Awkward edges

Paths are normalised before lookup, so `'/a/./b/../b'` and `'/a/b'` refer to the same node, and `realpathSync` returns that normalised form. Symlinks are resolved for `statSync`, `readFileSync`, and path traversal, but not for `lstatSync` or `readlinkSync`. A symlink whose target is relative is resolved against the directory containing the link. Writing past the current end of an open file extends it and zero-fills the gap, matching the behaviour of a sparse file on disk. `rmdirSync` refuses to remove a non-empty directory and throws `EACCES`, which is the same code Node uses for that case.

## API

The package exports `MemoryFileSystem` and the factory `createMemoryFileSystem()`, plus the error-code string constants `ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `EINVAL`, `EBADF`, and `EACCES`.

`MemoryFileSystem` provides: `readFileSync`, `writeFileSync`, `mkdirSync`, `readdirSync`, `unlinkSync`, `rmdirSync`, `statSync`, `lstatSync`, `symlinkSync`, `readlinkSync`, `existsSync`, `realpathSync`, `copyFileSync`, `renameSync`, `openSync`, `closeSync`, `fstatSync`, `readSync`, and `writeSync`. Two helpers, `dump()` and `reset()`, are included for test setup and teardown; `dump()` returns a deep copy of the tree so inspecting it cannot mutate the live filesystem.
