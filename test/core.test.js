import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFileSystem, ENOENT, EEXIST, EISDIR, ENOTDIR, EINVAL, EBADF, EACCES } from '../src/index.js';

test('writeFileSync and readFileSync round-trip utf8 text', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/hello.txt', 'hello world');
  assert.equal(fs.readFileSync('/hello.txt', 'utf8'), 'hello world');
  const buf = fs.readFileSync('/hello.txt');
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString('utf8'), 'hello world');
});

test('readFileSync on a missing path throws ENOENT', () => {
  const fs = createMemoryFileSystem();
  assert.throws(() => fs.readFileSync('/nope.txt'), (err) => err.code === ENOENT);
});

test('readFileSync on a directory throws EISDIR', () => {
  const fs = createMemoryFileSystem();
  fs.mkdirSync('/dir');
  assert.throws(() => fs.readFileSync('/dir'), (err) => err.code === EISDIR);
});

test('mkdirSync without recursive throws EEXIST when the directory exists', () => {
  const fs = createMemoryFileSystem();
  fs.mkdirSync('/a');
  assert.throws(() => fs.mkdirSync('/a'), (err) => err.code === EEXIST);
});

test('mkdirSync with recursive creates intermediate directories idempotently', () => {
  const fs = createMemoryFileSystem();
  fs.mkdirSync('/x/y/z', { recursive: true });
  assert.equal(fs.statSync('/x/y/z').isDirectory(), true);
  fs.mkdirSync('/x/y/z', { recursive: true });
  assert.equal(fs.statSync('/x/y/z').isDirectory(), true);
});

test('mkdirSync without recursive fails with ENOENT when the parent is missing', () => {
  const fs = createMemoryFileSystem();
  assert.throws(() => fs.mkdirSync('/missing/child'), (err) => err.code === ENOENT);
});

test('writeFileSync into a missing parent throws ENOENT', () => {
  const fs = createMemoryFileSystem();
  assert.throws(() => fs.writeFileSync('/no/such/file.txt', 'x'), (err) => err.code === ENOENT);
});

test('readdirSync lists names and withFileTypes reports kinds', () => {
  const fs = createMemoryFileSystem();
  fs.mkdirSync('/d');
  fs.writeFileSync('/d/a.txt', 'a');
  fs.mkdirSync('/d/sub');
  const names = fs.readdirSync('/d').sort();
  assert.deepEqual(names, ['a.txt', 'sub']);
  const entries = fs.readdirSync('/d', { withFileTypes: true });
  const byName = new Map(entries.map((e) => [e.name, e]));
  assert.equal(byName.get('a.txt').isFile(), true);
  assert.equal(byName.get('a.txt').isDirectory(), false);
  assert.equal(byName.get('sub').isDirectory(), true);
});

test('unlinkSync removes a file and reports ENOENT on a second call', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/gone.txt', 'x');
  fs.unlinkSync('/gone.txt');
  assert.equal(fs.existsSync('/gone.txt'), false);
  assert.throws(() => fs.unlinkSync('/gone.txt'), (err) => err.code === ENOENT);
});

test('unlinkSync on a directory throws EISDIR', () => {
  const fs = createMemoryFileSystem();
  fs.mkdirSync('/dir');
  assert.throws(() => fs.unlinkSync('/dir'), (err) => err.code === EISDIR);
});

test('rmdirSync refuses to remove a non-empty directory with EACCES', () => {
  const fs = createMemoryFileSystem();
  fs.mkdirSync('/parent');
  fs.writeFileSync('/parent/child.txt', 'x');
  assert.throws(() => fs.rmdirSync('/parent'), (err) => err.code === EACCES);
  fs.unlinkSync('/parent/child.txt');
  fs.rmdirSync('/parent');
  assert.equal(fs.existsSync('/parent'), false);
});

test('statSync returns a stat with mode bits and size', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/sized.txt', '12345');
  const st = fs.statSync('/sized.txt');
  assert.equal(st.size, 5);
  assert.equal(st.isFile(), true);
  assert.equal(st.isDirectory(), false);
  assert.ok((st.mode & 0o170000) === 0o100000);
});

test('statSync with bigint returns bigint fields', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/b.txt', 'abc');
  const st = fs.statSync('/b.txt', { bigint: true });
  assert.equal(typeof st.size, 'bigint');
  assert.equal(st.size, 3n);
});

test('symlinkSync then readlinkSync returns the stored target', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/target.txt', 't');
  fs.symlinkSync('/target.txt', '/link.txt');
  assert.equal(fs.readlinkSync('/link.txt'), '/target.txt');
  assert.equal(fs.readFileSync('/link.txt', 'utf8'), 't');
});

test('lstatSync does not follow a symlink while statSync does', () => {
  const fs = createMemoryFileSystem();
  fs.mkdirSync('/dir');
  fs.symlinkSync('/dir', '/dirlink');
  assert.equal(fs.lstatSync('/dirlink').isSymbolicLink(), true);
  assert.equal(fs.statSync('/dirlink').isDirectory(), true);
});

test('readlinkSync on a regular file throws EINVAL', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/plain.txt', 'x');
  assert.throws(() => fs.readlinkSync('/plain.txt'), (err) => err.code === EINVAL);
});

test('openSync with wx fails with EEXIST when the file already exists', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/exists.txt', 'x');
  assert.throws(() => fs.openSync('/exists.txt', 'wx'), (err) => err.code === EEXIST);
});

test('openSync with r on a missing file throws ENOENT', () => {
  const fs = createMemoryFileSystem();
  assert.throws(() => fs.openSync('/missing.txt', 'r'), (err) => err.code === ENOENT);
});

test('writeSync and readSync update the file through the descriptor', () => {
  const fs = createMemoryFileSystem();
  const fd = fs.openSync('/rw.txt', 'w+');
  const written = fs.writeSync(fd, Buffer.from('abcdef'), 0, 6, 0);
  assert.equal(written, 6);
  const out = Buffer.alloc(3);
  const read = fs.readSync(fd, out, 0, 3, 2);
  assert.equal(read, 3);
  assert.equal(out.toString('utf8'), 'cde');
  fs.closeSync(fd);
  assert.equal(fs.readFileSync('/rw.txt', 'utf8'), 'abcdef');
});

test('writeSync with a string writes from the start position', () => {
  const fs = createMemoryFileSystem();
  const fd = fs.openSync('/str.txt', 'w');
  const written = fs.writeSync(fd, 'hello', 0, 5, 0);
  assert.equal(written, 5);
  fs.closeSync(fd);
  assert.equal(fs.readFileSync('/str.txt', 'utf8'), 'hello');
});

test('append mode writes at the end regardless of position argument', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/log.txt', 'one');
  const fd = fs.openSync('/log.txt', 'a');
  fs.writeSync(fd, Buffer.from('two'), 0, 3, 0);
  fs.closeSync(fd);
  assert.equal(fs.readFileSync('/log.txt', 'utf8'), 'onetwo');
});

test('closeSync on an unknown descriptor throws EBADF', () => {
  const fs = createMemoryFileSystem();
  assert.throws(() => fs.closeSync(99), (err) => err.code === EBADF);
});

test('readSync on a closed descriptor throws EBADF', () => {
  const fs = createMemoryFileSystem();
  const fd = fs.openSync('/x.txt', 'w+');
  fs.closeSync(fd);
  assert.throws(() => fs.readSync(fd, Buffer.alloc(1), 0, 1, 0), (err) => err.code === EBADF);
});

test('fstatSync reports the same size as statSync', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/f.txt', '1234567');
  const fd = fs.openSync('/f.txt', 'r');
  assert.equal(fs.fstatSync(fd).size, 7);
  assert.equal(fs.fstatSync(fd).isFile(), true);
  fs.closeSync(fd);
});

test('copyFileSync duplicates file contents', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/src.txt', 'payload');
  fs.copyFileSync('/src.txt', '/dst.txt');
  assert.equal(fs.readFileSync('/dst.txt', 'utf8'), 'payload');
});

test('copyFileSync from a directory throws EISDIR', () => {
  const fs = createMemoryFileSystem();
  fs.mkdirSync('/d');
  assert.throws(() => fs.copyFileSync('/d', '/out.txt'), (err) => err.code === EISDIR);
});

test('renameSync moves a file and removes the old name', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/old.txt', 'v');
  fs.renameSync('/old.txt', '/new.txt');
  assert.equal(fs.existsSync('/old.txt'), false);
  assert.equal(fs.readFileSync('/new.txt', 'utf8'), 'v');
});

test('realpathSync normalises redundant segments', () => {
  const fs = createMemoryFileSystem();
  fs.mkdirSync('/a/b', { recursive: true });
  assert.equal(fs.realpathSync('/a/./b/../b'), '/a/b');
});

test('realpathSync on a missing path throws ENOENT', () => {
  const fs = createMemoryFileSystem();
  assert.throws(() => fs.realpathSync('/nope'), (err) => err.code === ENOENT);
});

test('reset clears both the tree and open descriptors', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/a.txt', 'x');
  const fd = fs.openSync('/a.txt', 'r');
  fs.reset();
  assert.equal(fs.existsSync('/a.txt'), false);
  assert.throws(() => fs.fstatSync(fd), (err) => err.code === EBADF);
});

test('dump returns a copy that does not mutate the live tree', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/p.txt', 'orig');
  const snapshot = fs.dump();
  fs.writeFileSync('/p.txt', 'changed');
  assert.equal(snapshot.children.get('p.txt').data.toString('utf8'), 'orig');
});

test('writeFileSync to a path whose parent is a file throws ENOTDIR', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/file.txt', 'x');
  assert.throws(() => fs.writeFileSync('/file.txt/child.txt', 'y'), (err) => err.code === ENOTDIR);
});

test('readdirSync on a file throws ENOTDIR', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/f.txt', 'x');
  assert.throws(() => fs.readdirSync('/f.txt'), (err) => err.code === ENOTDIR);
});

test('writeSync extends the file when writing past the current end', () => {
  const fs = createMemoryFileSystem();
  const fd = fs.openSync('/sparse.txt', 'w+');
  fs.writeSync(fd, Buffer.from('z'), 0, 1, 4);
  fs.closeSync(fd);
  const buf = fs.readFileSync('/sparse.txt');
  assert.equal(buf.length, 5);
  assert.equal(buf[4], 'z'.charCodeAt(0));
  assert.equal(buf[0], 0);
});

test('readSync returns 0 when reading at or past end of file', () => {
  const fs = createMemoryFileSystem();
  fs.writeFileSync('/short.txt', 'ab');
  const fd = fs.openSync('/short.txt', 'r');
  const out = Buffer.alloc(4);
  assert.equal(fs.readSync(fd, out, 0, 4, 10), 0);
  fs.closeSync(fd);
});

test('openSync with an unknown flag string throws EINVAL', () => {
  const fs = createMemoryFileSystem();
  assert.throws(() => fs.openSync('/x.txt', 'not-a-flag'), (err) => err.code === EINVAL);
});
