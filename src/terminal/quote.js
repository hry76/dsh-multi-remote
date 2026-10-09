/**
 * POSIX shell 引用工具。
 *
 * 单独成文件是为了避免循环依赖：`docker.js` 与 `terminal/backends.js` 都要用它，
 * 而后者又要引用前者。
 */

/**
 * 用单引号把一段文本包成 POSIX shell 的安全字面量。
 *
 * 单引号里除了单引号本身什么都不会被解释；`'` 用 `'\''` 断开再拼回去。
 * 这是**唯一**正确的做法 —— 反斜杠转义在 shell 里各处分歧太多。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
