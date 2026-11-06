import { Buffer } from 'node:buffer';
import { constants as fsConstants } from 'node:fs';

// Error codes mirror the subset of POSIX errno values that Node's fs module
// exposes. Keeping them as plain strings (rather than Error subclasses) means
// callers can compare err.code without importing anything from this package.
export const ENOENT = 'ENOENT';
export const EEXIST = 'EEXIST';
export const EISDIR = 'EISDIR';
export const ENOTDIR = 'ENOTDIR';
export const EINVAL = 'EINVAL';
export const EBADF = 'EBADF';
export const EACCES = 'EACCES';

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function makeError(code, syscall, path) {
  const err = new Error(`${code}: ${syscall} '${path}'`);
  err.code = code;
  err.errno = code;
  err.syscall = syscall;
  err.path = path;
  return err;
}

// FileSystemError is not exported directly; callers are expected to inspect
// err.code, which is the stable contract Node itself offers.
function fsError(code, syscall, path) {
  return makeError(code, syscall, path);
}

const EMPTY = Buffer.alloc(0);

function normalizePath(path) {
  if (typeof path !== 'string') {
    throw fsError(EINVAL, 'open', String(path));
  }
  if (path.length === 0) {
    throw fsError(ENOENT, 'open', path);
  }
  const parts = path.split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (out.length > 0) {
        out.pop();
      }
      continue;
    }
    out.push(part);
  }
  return '/' + out.join('/');
}

function parentAndBase(normalized) {
  if (normalized === '/') {
    return { parent: null, base: '' };
  }
  const idx = normalized.lastIndexOf('/');
  if (idx === 0) {
    return { parent: '/', base: normalized.slice(1) };
  }
  return { parent: normalized.slice(0, idx), base: normalized.slice(idx + 1) };
}

function isDirectory(node) {
  return node !== null && node !== undefined && node.kind === 'dir';
}

function isFile(node) {
  return node !== null && node !== undefined && node.kind === 'file';
}

function isSymlink(node) {
  return node !== null && node !== undefined && node.kind === 'symlink';
}

function isDir(node) {
  return isDirectory(node);
}

function makeDir() {
  return { kind: 'dir', children: new Map(), mode: 0o777 };
}

function makeFile(data, mode) {
  return { kind: 'file', data: Buffer.from(data), mode: mode === undefined ? 0o666 : mode };
}

function makeSymlink(target, mode) {
  return { kind: 'symlink', target, mode: mode === undefined ? 0o777 : mode };
}

function cloneNode(node) {
  if (isFile(node)) {
    return makeFile(node.data, node.mode);
  }
  if (isDir(node)) {
    const dir = makeDir();
    dir.mode = node.mode;
    for (const [name, child] of node.children) {
      dir.children.set(name, cloneNode(child));
    }
    return dir;
  }
  if (isSymlink(node)) {
    return makeSymlink(node.target, node.mode);
  }
  return node;
}

function resolvePath(root, path, followFinal) {
  const normalized = normalizePath(path);
  if (normalized === '/') {
    return { node: root, normalized };
  }
  const parts = normalized.split('/').filter((p) => p !== '');
  let current = root;
  let traversed = '';
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    traversed += '/' + part;
    if (isSymlink(current)) {
      // Resolve the symlink and restart from the target. This is only correct
      // for absolute targets; relative symlink targets are interpreted relative
      // to the directory containing the link, which we reconstruct here.
      const linkParent = parentAndBase(traversed.slice(0, traversed.length - part.length - 1)).parent;
      const base = linkParent === null ? '/' : linkParent;
      const target = current.target.startsWith('/')
        ? current.target
        : normalizePath(base + '/' + current.target);
      const resolved = resolvePath(root, target, false);
      current = resolved.node;
    }
    if (!isDir(current)) {
      throw fsError(ENOTDIR, 'open', traversed);
    }
    const next = current.children.get(part);
    if (next === undefined) {
      throw fsError(ENOENT, 'open', traversed);
    }
    current = next;
  }
  if (followFinal && isSymlink(current)) {
    const base = parentAndBase(normalized).parent;
    const target = current.target.startsWith('/')
      ? current.target
      : normalizePath((base === null ? '/' : base) + '/' + current.target);
    return resolvePath(root, target, false);
  }
  return { node: current, normalized };
}

function statFromNode(node, bigint) {
  const size = isFile(node) ? node.data.length : 0;
  const stat = {
    dev: 0,
    ino: 0,
    mode: node.mode,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size,
    blksize: 4096,
    blocks: Math.ceil(size / 512),
    atimeMs: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    birthtimeMs: 0,
    atime: new Date(0),
    mtime: new Date(0),
    ctime: new Date(0),
    birthtime: new Date(0),
    isFile() {
      return isFile(node);
    },
    isDirectory() {
      return isDir(node);
    },
    isSymbolicLink() {
      return isSymlink(node);
    },
    isBlockDevice() {
      return false;
    },
    isCharacterDevice() {
      return false;
    },
    isFIFO() {
      return false;
    },
    isSocket() {
      return false;
    },
  };
  if (isDir(node)) {
    stat.mode = (stat.mode & ~S_IFMT) | S_IFDIR;
  } else if (isFile(node)) {
    stat.mode = (stat.mode & ~S_IFMT) | S_IFREG;
  } else if (isSymlink(node)) {
    stat.mode = (stat.mode & ~S_IFMT) | S_IFLNK;
  }
  if (bigint) {
    for (const key of ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks']) {
      stat[key] = BigInt(stat[key]);
    }
    for (const key of ['atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs']) {
      stat[key] = BigInt(stat[key]);
    }
  }
  return stat;
}

function writeAll(fd, buffer, offset, length, position, fs) {
  const file = fs._files.get(fd);
  if (file === undefined) {
    throw fsError(EBADF, 'write', String(fd));
  }
  if (file.kind !== 'file') {
    throw fsError(EISDIR, 'write', String(fd));
  }
  const start = file.append || position === null || position === undefined ? file.node.data.length : position;
  const data = Buffer.from(buffer);
  const end = start + length;
  if (end > file.node.data.length) {
    const grown = Buffer.alloc(end);
    file.node.data.copy(grown, 0);
    file.node.data = grown;
  }
  data.copy(file.node.data, start, offset, offset + length);
  if (position === null || position === undefined) {
    file.position = end;
  }
  return length;
}

function readAll(fd, buffer, offset, length, position, fs) {
  const file = fs._files.get(fd);
  if (file === undefined) {
    throw fsError(EBADF, 'read', String(fd));
  }
  if (file.kind !== 'file') {
    throw fsError(EISDIR, 'read', String(fd));
  }
  const start = position === null || position === undefined ? file.position : position;
  if (start >= file.node.data.length) {
    return 0;
  }
  const available = file.node.data.length - start;
  const n = Math.min(length, available);
  file.node.data.copy(buffer, offset, start, start + n);
  if (position === null || position === undefined) {
    file.position = start + n;
  }
  return n;
}

function parseOpenFlags(flags) {
  if (typeof flags === 'number') {
    return flags;
  }
  if (typeof flags === 'string') {
    const map = {
      r: fsConstants.O_RDONLY,
      'r+': fsConstants.O_RDWR,
      rs: fsConstants.O_RDONLY,
      'rs+': fsConstants.O_RDWR,
      w: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
      wx: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_EXCL,
      'w+': fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC,
      'wx+': fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_EXCL,
      a: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND,
      ax: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_EXCL,
      'a+': fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND,
      'ax+': fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_EXCL,
    };
    if (!(flags in map)) {
      throw fsError(EINVAL, 'open', flags);
    }
    return map[flags];
  }
  throw fsError(EINVAL, 'open', String(flags));
}

function readFileSyncImpl(fs, path, options) {
  const { node } = resolvePath(fs._root, path, true);
  if (!isFile(node)) {
    throw fsError(EISDIR, 'read', normalizePath(path));
  }
  const encoding = options && typeof options === 'object' ? options.encoding : options;
  if (encoding && encoding !== 'buffer') {
    return node.data.toString(encoding);
  }
  return Buffer.from(node.data);
}

function writeFileSyncImpl(fs, path, data, options) {
  const normalized = normalizePath(path);
  if (normalized === '/') {
    throw fsError(EISDIR, 'open', normalized);
  }
  const { parent, base } = parentAndBase(normalized);
  const parentResolved = resolvePath(fs._root, parent, true);
  if (!isDir(parentResolved.node)) {
    throw fsError(ENOTDIR, 'open', normalized);
  }
  const existing = parentResolved.node.children.get(base);
  if (existing !== undefined && isDir(existing)) {
    throw fsError(EISDIR, 'open', normalized);
  }
  const encoding = options && typeof options === 'object' ? options.encoding : options;
  let buf;
  if (typeof data === 'string') {
    buf = Buffer.from(data, encoding || 'utf8');
  } else if (Buffer.isBuffer(data)) {
    buf = Buffer.from(data);
  } else if (data instanceof Uint8Array) {
    buf = Buffer.from(data);
  } else {
    throw fsError(EINVAL, 'write', normalized);
  }
  if (existing === undefined) {
    parentResolved.node.children.set(base, makeFile(buf));
  } else {
    existing.data = buf;
  }
}

function mkdirSyncImpl(fs, path, options) {
  const normalized = normalizePath(path);
  if (normalized === '/') {
    if (options && options.recursive) {
      return undefined;
    }
    throw fsError(EEXIST, 'mkdir', normalized);
  }
  const recursive = options && options.recursive === true;
  if (recursive) {
    const parts = normalized.split('/').filter((p) => p !== '');
    let current = fs._root;
    for (const part of parts) {
      let next = current.children.get(part);
      if (next === undefined) {
        next = makeDir();
        current.children.set(part, next);
      } else if (!isDir(next)) {
        throw fsError(ENOTDIR, 'mkdir', normalized);
      }
      current = next;
    }
    return undefined;
  }
  const { parent, base } = parentAndBase(normalized);
  const parentResolved = resolvePath(fs._root, parent, true);
  if (!isDir(parentResolved.node)) {
    throw fsError(ENOTDIR, 'mkdir', normalized);
  }
  if (parentResolved.node.children.has(base)) {
    throw fsError(EEXIST, 'mkdir', normalized);
  }
  parentResolved.node.children.set(base, makeDir());
  return undefined;
}

function readdirSyncImpl(fs, path, options) {
  const { node } = resolvePath(fs._root, path, true);
  if (!isDir(node)) {
    throw fsError(ENOTDIR, 'scandir', normalizePath(path));
  }
  const names = Array.from(node.children.keys());
  if (options && options.withFileTypes) {
    return names.map((name) => {
      const child = node.children.get(name);
      const stat = statFromNode(child, false);
      return {
        name,
        isFile: () => stat.isFile(),
        isDirectory: () => stat.isDirectory(),
        isSymbolicLink: () => stat.isSymbolicLink(),
      };
    });
  }
  return names;
}

function unlinkSyncImpl(fs, path) {
  const normalized = normalizePath(path);
  const { parent, base } = parentAndBase(normalized);
  const parentResolved = resolvePath(fs._root, parent, true);
  if (!isDir(parentResolved.node)) {
    throw fsError(ENOTDIR, 'unlink', normalized);
  }
  const node = parentResolved.node.children.get(base);
  if (node === undefined) {
    throw fsError(ENOENT, 'unlink', normalized);
  }
  if (isDir(node)) {
    throw fsError(EISDIR, 'unlink', normalized);
  }
  parentResolved.node.children.delete(base);
}

function rmdirSyncImpl(fs, path) {
  const normalized = normalizePath(path);
  const { parent, base } = parentAndBase(normalized);
  const parentResolved = resolvePath(fs._root, parent, true);
  if (!isDir(parentResolved.node)) {
    throw fsError(ENOTDIR, 'rmdir', normalized);
  }
  const node = parentResolved.node.children.get(base);
  if (node === undefined) {
    throw fsError(ENOENT, 'rmdir', normalized);
  }
  if (!isDir(node)) {
    throw fsError(ENOTDIR, 'rmdir', normalized);
  }
  if (node.children.size > 0) {
    throw fsError(EACCES, 'rmdir', normalized);
  }
  parentResolved.node.children.delete(base);
}

function statSyncImpl(fs, path, options) {
  const { node } = resolvePath(fs._root, path, true);
  return statFromNode(node, options && options.bigint === true);
}

function lstatSyncImpl(fs, path, options) {
  const { node } = resolvePath(fs._root, path, false);
  return statFromNode(node, options && options.bigint === true);
}

function symlinkSyncImpl(fs, target, path) {
  const normalized = normalizePath(path);
  const { parent, base } = parentAndBase(normalized);
  const parentResolved = resolvePath(fs._root, parent, true);
  if (!isDir(parentResolved.node)) {
    throw fsError(ENOTDIR, 'symlink', normalized);
  }
  if (parentResolved.node.children.has(base)) {
    throw fsError(EEXIST, 'symlink', normalized);
  }
  parentResolved.node.children.set(base, makeSymlink(target));
}

function readlinkSyncImpl(fs, path) {
  const { node } = resolvePath(fs._root, path, false);
  if (!isSymlink(node)) {
    throw fsError(EINVAL, 'readlink', normalizePath(path));
  }
  return node.target;
}

function existsSyncImpl(fs, path) {
  try {
    resolvePath(fs._root, path, true);
    return true;
  } catch {
    return false;
  }
}

function realpathSyncImpl(fs, path) {
  const { normalized } = resolvePath(fs._root, path, true);
  return normalized;
}

function copyFileSyncImpl(fs, src, dest) {
  const { node } = resolvePath(fs._root, src, true);
  if (!isFile(node)) {
    throw fsError(EISDIR, 'copyfile', normalizePath(src));
  }
  writeFileSyncImpl(fs, dest, Buffer.from(node.data));
}

function renameSyncImpl(fs, oldPath, newPath) {
  const oldNormalized = normalizePath(oldPath);
  const { parent: oldParent, base: oldBase } = parentAndBase(oldNormalized);
  const oldParentResolved = resolvePath(fs._root, oldParent, true);
  if (!isDir(oldParentResolved.node)) {
    throw fsError(ENOTDIR, 'rename', oldNormalized);
  }
  const node = oldParentResolved.node.children.get(oldBase);
  if (node === undefined) {
    throw fsError(ENOENT, 'rename', oldNormalized);
  }
  const newNormalized = normalizePath(newPath);
  const { parent: newParent, base: newBase } = parentAndBase(newNormalized);
  const newParentResolved = resolvePath(fs._root, newParent, true);
  if (!isDir(newParentResolved.node)) {
    throw fsError(ENOTDIR, 'rename', newNormalized);
  }
  oldParentResolved.node.children.delete(oldBase);
  newParentResolved.node.children.set(newBase, node);
}

function openSyncImpl(fs, path, flags, mode) {
  const normalized = normalizePath(path);
  const numericFlags = parseOpenFlags(flags);
  const wantCreate = (numericFlags & fsConstants.O_CREAT) !== 0;
  const wantExcl = (numericFlags & fsConstants.O_EXCL) !== 0;
  const wantTrunc = (numericFlags & fsConstants.O_TRUNC) !== 0;
  const wantAppend = (numericFlags & fsConstants.O_APPEND) !== 0;
  const wantRead = (numericFlags & fsConstants.O_RDONLY) === fsConstants.O_RDONLY || (numericFlags & fsConstants.O_RDWR) !== 0;
  const wantWrite = (numericFlags & fsConstants.O_WRONLY) === fsConstants.O_WRONLY || (numericFlags & fsConstants.O_RDWR) !== 0;

  let node;
  try {
    const resolved = resolvePath(fs._root, normalized, true);
    node = resolved.node;
  } catch (err) {
    if (err.code !== ENOENT || !wantCreate) {
      throw err;
    }
    if (wantExcl) {
      throw fsError(EEXIST, 'open', normalized);
    }
    writeFileSyncImpl(fs, normalized, EMPTY);
    node = resolvePath(fs._root, normalized, true).node;
  }

  if (isDir(node)) {
    throw fsError(EISDIR, 'open', normalized);
  }
  if (isSymlink(node)) {
    throw fsError(EINVAL, 'open', normalized);
  }
  if (wantExcl && wantCreate) {
    throw fsError(EEXIST, 'open', normalized);
  }
  if (wantTrunc && wantWrite) {
    node.data = Buffer.alloc(0);
  }
  const fd = fs._nextFd;
  fs._nextFd += 1;
  fs._files.set(fd, {
    kind: 'file',
    node,
    position: wantAppend ? node.data.length : 0,
    flags: numericFlags,
    readable: wantRead || (!wantRead && !wantWrite),
    writable: wantWrite,
    append: wantAppend,
  });
  return fd;
}

function closeSyncImpl(fs, fd) {
  if (!fs._files.has(fd)) {
    throw fsError(EBADF, 'close', String(fd));
  }
  fs._files.delete(fd);
}

function fstatSyncImpl(fs, fd, options) {
  const file = fs._files.get(fd);
  if (file === undefined) {
    throw fsError(EBADF, 'fstat', String(fd));
  }
  return statFromNode(file.node, options && options.bigint === true);
}

function readSyncImpl(fs, fd, buffer, offset, length, position) {
  if (!Buffer.isBuffer(buffer)) {
    throw fsError(EINVAL, 'read', String(fd));
  }
  return readAll(fd, buffer, offset, length, position, fs);
}

function writeSyncImpl(fs, fd, buffer, offset, length, position) {
  if (typeof buffer === 'string') {
    const buf = Buffer.from(buffer);
    return writeAll(fd, buf, 0, buf.length, position, fs);
  }
  if (!Buffer.isBuffer(buffer)) {
    throw fsError(EINVAL, 'write', String(fd));
  }
  return writeAll(fd, buffer, offset, length, position, fs);
}

export class MemoryFileSystem {
  constructor() {
    this._root = makeDir();
    this._files = new Map();
    this._nextFd = 3;
  }

  readFileSync(path, options) {
    return readFileSyncImpl(this, path, options);
  }

  writeFileSync(path, data, options) {
    writeFileSyncImpl(this, path, data, options);
  }

  mkdirSync(path, options) {
    return mkdirSyncImpl(this, path, options);
  }

  readdirSync(path, options) {
    return readdirSyncImpl(this, path, options);
  }

  unlinkSync(path) {
    unlinkSyncImpl(this, path);
  }

  rmdirSync(path) {
    rmdirSyncImpl(this, path);
  }

  statSync(path, options) {
    return statSyncImpl(this, path, options);
  }

  lstatSync(path, options) {
    return lstatSyncImpl(this, path, options);
  }

  symlinkSync(target, path) {
    symlinkSyncImpl(this, target, path);
  }

  readlinkSync(path) {
    return readlinkSyncImpl(this, path);
  }

  existsSync(path) {
    return existsSyncImpl(this, path);
  }

  realpathSync(path) {
    return realpathSyncImpl(this, path);
  }

  copyFileSync(src, dest) {
    copyFileSyncImpl(this, src, dest);
  }

  renameSync(oldPath, newPath) {
    renameSyncImpl(this, oldPath, newPath);
  }

  openSync(path, flags, mode) {
    return openSyncImpl(this, path, flags, mode);
  }

  closeSync(fd) {
    closeSyncImpl(this, fd);
  }

  fstatSync(fd, options) {
    return fstatSyncImpl(this, fd, options);
  }

  readSync(fd, buffer, offset, length, position) {
    return readSyncImpl(this, fd, buffer, offset, length, position);
  }

  writeSync(fd, buffer, offset, length, position) {
    return writeSyncImpl(this, fd, buffer, offset, length, position);
  }

  // Convenience helpers that are not part of the Node fs interface but make
  // the stub usable in tests without reaching into private fields.
  dump() {
    return cloneNode(this._root);
  }

  reset() {
    this._root = makeDir();
    this._files.clear();
    this._nextFd = 3;
  }
}

export function createMemoryFileSystem() {
  return new MemoryFileSystem();
}
