/**
 * 忽略规则 —— 决定「哪些东西不往锚点镜像里搬」。
 *
 * 为什么必须自己实现：宿主的 `@` 补全**不认 `.gitignore`**，只认一份硬编码目录名黑名单
 * （`.git`、`node_modules`、`dist`、`build`…）。锚点镜像如果照搬那份清单，就会把
 * `vendor/`、`target/`、`out/`、`.venv/` 这类项目级忽略目录全拉下来 —— 格局层一开就卡死。
 * 所以镜像层自己读项目根的 `.gitignore`。
 *
 * 语法按 gitignore(5) 实现到一个**明确划定的子集**（见 README 的「支持范围」）：
 *   - 注释 `#`、转义 `\#`、空行
 *   - 取反 `!pattern`（后出现的规则覆盖先出现的）
 *   - 目录限定 `pattern/`
 *   - 锚定 `/pattern`（相对仓库根）；不含 `/` 的模式匹配任意层级
 *   - `**` 跨目录、`*` 不跨 `/`、`?` 单字符、`[...]` 字符类
 *
 * **不**实现（有意）：`.git/info/exclude`、全局 `core.excludesFile`、
 * 父目录的 `.gitignore`、以及 git 的「目录被忽略则不再下潜」之外的历史遗留行为。
 */

/** 把 gitignore 的一个 glob 片段编译成正则源码。`*` 不跨 `/`，`**` 跨。 */
function globToRegExpSource(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === '\\') {
      // 转义下一个字符：按字面量处理
      const next = glob[i + 1]
      if (next === undefined) {
        out += '\\\\'
      } else {
        out += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        i += 1
      }
      continue
    }
    if (ch === '*') {
      const isDouble = glob[i + 1] === '*'
      if (isDouble) {
        // `**` 语义：吃掉任意层目录
        const afterDouble = glob[i + 2]
        if (afterDouble === '/') {
          out += '(?:[^/]+/)*'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    if (ch === '[') {
      // 字符类：原样搬进正则，但把 `!` 换成 `^`（gitignore 用 `!` 表示取反）
      let j = i + 1
      let cls = ''
      if (glob[j] === '!' || glob[j] === '^') {
        cls += '^'
        j += 1
      }
      for (; j < glob.length && glob[j] !== ']'; j += 1) {
        cls += glob[j] === '\\' ? '\\\\' : glob[j]
      }
      if (j >= glob.length) {
        // 没有闭合的 `[` —— 按字面量处理，避免把整条规则变成非法正则
        out += '\\['
      } else {
        out += `[${cls}]`
        i = j
      }
      continue
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return out
}

/** 一条编译好的规则。 */
class Rule {
  /**
   * @param {string} source 原始行（去掉首尾空白前）
   * @param {string} body 去掉 `!` 与结尾 `/` 之后的模式
   * @param {boolean} negated 是否为 `!` 取反规则
   * @param {boolean} directoryOnly 是否只匹配目录
   * @param {boolean} anchored 是否锚定到仓库根
   */
  constructor(source, body, negated, directoryOnly, anchored) {
    this.source = source
    this.negated = negated
    this.directoryOnly = directoryOnly
    this.anchored = anchored

    const core = globToRegExpSource(body)
    // 不锚定的模式匹配任意层级；锚定的从根开始。
    // 匹配的是「从仓库根算起的相对路径」，因此统一用 `^` 起头。
    this.regexp = new RegExp(anchored ? `^${core}$` : `^(?:.*/)?${core}$`)
    // 目录限定规则：目录本身命中即可，其内容由「不下潜」保证
    this.prefixRegexp = this.regexp
  }

  /**
   * @param {string} relPath 相对仓库根的 POSIX 路径（不含前导 `/`）
   * @param {boolean} isDirectory 该路径是否是目录
   * @returns {boolean} 是否命中本规则
   */
  matches(relPath, isDirectory) {
    if (this.directoryOnly && !isDirectory) return false
    return this.regexp.test(relPath)
  }
}

/**
 * 一份忽略规则集。用「最后一条命中的规则说话」的 git 语义求值。
 */
export class IgnoreRules {
  /**
   * @param {Rule[]} rules 已编译的规则，按文件出现顺序
   */
  constructor(rules = []) {
    /** @type {Rule[]} */
    this.rules = rules
  }

  /** 空规则集（什么都不忽略）。 */
  static empty() {
    return new IgnoreRules([])
  }

  /**
   * 解析 `.gitignore` 文本。
   * @param {string} text
   * @returns {IgnoreRules}
   */
  static parse(text) {
    const rules = []
    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
      const rule = parseLine(rawLine)
      if (rule !== undefined) rules.push(rule)
    }
    return new IgnoreRules(rules)
  }

  /**
   * 合并多份规则集，顺序保持「先来的先生效」。
   * @param {...IgnoreRules} sets
   * @returns {IgnoreRules}
   */
  static merge(...sets) {
    return new IgnoreRules(sets.flatMap((set) => set?.rules ?? []))
  }

  /**
   * 是否忽略某个路径。
   *
   * 语义要点：**被忽略的目录不再下潜**，所以调用方在遍历时必须先问目录本身，
   * 得到 `true` 就整棵剪掉 —— 否则 `!keep.txt` 之类的取反规则会把人引到已经忽略的
   * 目录里去，那与 git 的行为不一致。
   *
   * @param {string} relPath 相对仓库根的 POSIX 路径
   * @param {{ isDirectory?: boolean }} [options]
   * @returns {boolean}
   */
  ignores(relPath, options = {}) {
    const isDirectory = options.isDirectory === true
    const path = normalizeRelPath(relPath)
    if (path === '') return false

    let ignored = false
    for (const rule of this.rules) {
      if (rule.matches(path, isDirectory)) ignored = !rule.negated
    }
    return ignored
  }

  /** 规则条数（诊断用）。 */
  get size() {
    return this.rules.length
  }
}

/** 归一化成「相对仓库根的 POSIX 路径」，去掉 `./` 与重复 `/`。 */
function normalizeRelPath(input) {
  return String(input ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

/** 解析一行；返回 `undefined` 表示这行不是有效规则。 */
function parseLine(rawLine) {
  const source = String(rawLine ?? '')
  // 行尾空白在 git 里是有意义的（除非被转义），这里按常见实现裁掉尾随空白与 CR
  let line = source.replace(/\r$/, '')
  if (line.trim() === '') return undefined
  if (line.startsWith('#')) return undefined

  let negated = false
  if (line.startsWith('!')) {
    negated = true
    line = line.slice(1)
  } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
    line = line.slice(1)
  }

  // 尾部未转义的 `/` → 目录限定
  let directoryOnly = false
  if (line.endsWith('/') && !line.endsWith('\\/')) {
    directoryOnly = true
    line = line.slice(0, -1)
  }
  if (line === '') return undefined

  // 模式中间的 `/` → 锚定到仓库根；开头 `/` 也是锚定
  let anchored = false
  if (line.startsWith('/')) {
    anchored = true
    line = line.slice(1)
  } else if (line.slice(0, -1).includes('/')) {
    anchored = true
  }
  if (line === '') return undefined

  return new Rule(source, line, negated, directoryOnly, anchored)
}

/**
 * 内置兜底规则 —— 即便项目没有 `.gitignore`，这些也绝不搬进镜像。
 *
 * 选取标准只有一条：**搬下来对界面没有任何价值，却会拖垮格局层**。
 * 刻意保持短：真正的忽略交给项目自己的 `.gitignore`。
 */
export const BUILTIN_IGNORES = IgnoreRules.parse([
  '# 版本控制元数据：镜像层自己会建仓库，远程的 .git 不搬',
  '.git/',
  '# 镜像自身的状态目录（锚点里由我们创建，远程侧不存在也不该搬）',
  '.dsh-multi-remote/',
  '# 依赖与构建产物（各语言最常见的几类）',
  'node_modules/',
  '.pnpm-store/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '.mypy_cache/',
  '.pytest_cache/',
  'target/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.gradle/',
  '.idea/',
  '.DS_Store',
].join('\n'))
