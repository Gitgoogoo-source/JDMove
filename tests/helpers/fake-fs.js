// 内存版 FileSystemDirectoryHandle：只实现插件用到的方法
export function fakeDir(name = 'root') {
  const entries = new Map();
  const dir = {
    kind: 'directory',
    name,
    async getDirectoryHandle(child, { create = false } = {}) {
      const found = entries.get(child);
      if (found?.kind === 'directory') return found;
      if (found || !create) throw new DOMException(`${child} not found`, 'NotFoundError');
      const created = fakeDir(child);
      entries.set(child, created);
      return created;
    },
    async getFileHandle(child, { create = false } = {}) {
      const found = entries.get(child);
      if (found?.kind === 'file') return found;
      if (found || !create) throw new DOMException(`${child} not found`, 'NotFoundError');
      const file = {
        kind: 'file',
        name: child,
        data: null,
        async createWritable() {
          return {
            write: async (d) => {
              file.data = d;
            },
            close: async () => {},
          };
        },
      };
      entries.set(child, file);
      return file;
    },
    async removeEntry(child) {
      if (!entries.delete(child)) throw new DOMException(`${child} not found`, 'NotFoundError');
    },
    async *entries() {
      yield* entries.entries();
    },
    /** 测试用：列出所有文件路径 */
    tree(prefix = '') {
      return [...entries.values()].flatMap((e) =>
        e.kind === 'directory' ? e.tree(`${prefix}${e.name}/`) : [`${prefix}${e.name}`],
      );
    },
    read(path) {
      const [head, ...rest] = path.split('/');
      const e = entries.get(head);
      return rest.length ? e?.read(rest.join('/')) : e?.data;
    },
  };
  return dir;
}
