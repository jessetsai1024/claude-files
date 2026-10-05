/** 一行裡的一小段字，帶自己的顏色與粗細。 */
export type Segment = {
  /** 要顯示的字。 */
  text: string
  /** 顏色，`#rrggbb`；沒給就是終端機預設字色。 */
  color?: string
  /** 粗體。 */
  bold?: boolean
  /** 暗一階，給次要資訊用。 */
  dim?: boolean
  /** 放不下要裁的時候留結尾、開頭補「…」（檔案路徑用）；只影響排版，畫的時候不看。 */
  keepTail?: boolean
}

/** 畫面上的一行：由左到右排的幾段字；空陣列是空白行。 */
export type Line = Segment[]

/** 一次工具呼叫對一個檔案做的改動。 */
export type Change = {
  /** 檔案的絕對路徑。 */
  path: string
  /** 這次是新建的（原本沒有這個檔案）。 */
  isNew: boolean
  /** 加了幾行。 */
  added: number
  /** 刪了幾行。 */
  removed: number
  /** 這次被刪掉了（指令跑之前在、跑完不在）；沒寫就是沒刪。 */
  isGone?: boolean
  /** 這是資料夾不是檔案（目前只有刪掉資料夾會出現）；沒寫就是檔案。 */
  isDir?: boolean
}

/** 指令前後查到的一個路徑：一般檔案是它的修改時間（毫秒），資料夾是 'dir'，不存在或查不到是 null。 */
export type Seen = number | 'dir' | null

/** 清單上的一個檔案，畫面要的全部資料。 */
export type FileRow = {
  /** 檔案的絕對路徑。 */
  path: string
  /** 它屬於哪個資料夾（分組用）：專案資料夾，找不到就是它所在的資料夾。 */
  root: string
  /** new 是這次對話新建的，changed 是本來就有、被改過的。 */
  kind: 'new' | 'changed'
  /** 用 Write、Edit 改的加了幾行（指令改的不算）。 */
  added: number
  /** 用 Write、Edit 改的刪了幾行（指令改的不算）。 */
  removed: number
  /** 有沒有用 Write、Edit 改過；false 表示只被指令改過，行數不知道。 */
  hasCounts: boolean
  /** 改過幾次。 */
  count: number
  /** 最後一次是哪種幫手改的；主對話改的是 undefined。 */
  who?: string
  /** 最後一次改的時間，毫秒。 */
  lastAt: number
  /** 已經不在硬碟上了。 */
  isGone: boolean
  /** 這一行是資料夾（被指令整個刪掉的那種），畫的時候路徑後面加「/」；沒寫就是檔案。 */
  isDir?: boolean
}

const NEW = '#5ad67d'
const CHANGED = '#f7d154'
const GONE = '#ff6b6b'
const DIM = '#6b7280'
const HELPER = '#ff7eb6'
const MAX_CANDIDATES = 40
// 換目錄的指令（bash 和 PowerShell），比對時一律小寫
const CD_VERBS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl'])
// 會讓檔案或資料夾消失的指令；出現時沒有副檔名的單字也當路徑查
const REMOVE_VERBS = new Set(['rm', 'rmdir', 'unlink', 'trash', 'mv', 'del', 'erase', 'rd', 'remove-item', 'ri', 'move', 'move-item', 'mi'])

/**
 * 【行為】一段字在終端機佔幾格寬：中日韓文字、全形標點、表情符號算 2 格，其他算 1 格。
 *   跟 ctx-panel 的同名函式一樣。
 */
export function widthOf(text: string): number {
  let width = 0

  for (const glyph of text) {
    const code = glyph.codePointAt(0) ?? 0
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    width += isWide ? 2 : 1
  }

  return width
}

/**
 * 【行為】把一段字裁到最多 max 格寬。超過時留開頭、結尾補「…」；keepTail 為 true 時改成留結尾、開頭補「…」。
 *   本來就放得下就原樣回傳。max 小於 1 回空字串。
 */
export function fit(text: string, max: number, keepTail = false): string {
  if (widthOf(text) <= max) {
    return text
  }

  if (max < 1) {
    return ''
  }

  const glyphs = Array.from(text)
  let kept = ''

  if (keepTail) {
    for (let at = glyphs.length - 1; at >= 0; at -= 1) {
      const next = (glyphs[at] ?? '') + kept

      if (widthOf(next) > max - 1) {
        break
      }

      kept = next
    }

    return `…${kept}`
  }

  for (const glyph of glyphs) {
    if (widthOf(kept + glyph) > max - 1) {
      break
    }

    kept += glyph
  }

  return `${kept}…`
}

/** 【行為】把「過了多久」寫成白話：不到 1 秒是「剛剛」，再來是「12 秒前」「3 分前」「2 小時前」。 */
export function agoOf(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)

  if (seconds < 1) {
    return '剛剛'
  }

  if (seconds < 60) {
    return `${seconds} 秒前`
  }

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} 分前`
  }

  return `${Math.floor(seconds / 3600)} 小時前`
}

/** 【行為】判斷是不是絕對路徑：以「/」或「\\」開頭，或 Windows 的「C:\\」「C:/」這種磁碟機代號開頭。 */
export function isAbsolute(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:([\\/]|$)/.test(path)
}

/** 【行為】判斷是不是根目錄：「/」，或 Windows 的「C:/」（normalize 過的寫法）。 */
export function isRoot(path: string): boolean {
  return path === '/' || /^[A-Za-z]:\/$/.test(path)
}

/**
 * 【行為】拿來比對「是不是同一個檔案」的寫法，路徑要先 normalize 過。
 *   磁碟機代號開頭的（Windows）整串換成小寫，因為 Windows 不分大小寫，C:/Users/A.txt 跟 c:/users/a.txt 是同一個；
 *   其他路徑原樣回傳。只拿來比對和當清單的索引，畫面上顯示的還是原本的寫法。
 */
export function keyOf(path: string): string {
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path
}

/**
 * 【行為】把路徑整理乾淨：Windows 的「\\」先換成「/」、連續的「/」併成一個、「.」拿掉、「..」往上一層、
 *   結尾的「/」拿掉（根目錄除外）。Windows 的磁碟機代號留在開頭（C:\\Users\\a\\..\\b → C:/Users/b），
 *   往上超過磁碟機就停在「C:/」。相對路徑整理到空的回「.」。
 */
export function normalize(path: string): string {
  const posix = path.replace(/\\/g, '/')
  const drive = /^[A-Za-z]:(?=\/|$)/.exec(posix)?.[0] ?? ''
  const rest = posix.slice(drive.length)
  const isAbs = drive !== '' || rest.startsWith('/')
  const parts: string[] = []

  for (const part of rest.split('/')) {
    if (part === '' || part === '.') {
      continue
    }

    if (part === '..') {
      parts.pop()
    } else {
      parts.push(part)
    }
  }

  const body = parts.join('/')

  return isAbs ? `${drive}/${body}` : body || '.'
}

/** 【行為】把一段文字的行數算出來：空字串 0 行，結尾的換行不多算一行。 */
export function lineCountOf(text: string): number {
  if (text === '') {
    return 0
  }

  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** 【行為】數一份 structuredPatch（[{ lines: ['+…', '-…', ' …'] }]）裡加了幾行、刪了幾行；格式不對就當 0。 */
export function patchCountOf(patch: unknown): { added: number; removed: number } {
  let added = 0
  let removed = 0

  if (Array.isArray(patch)) {
    for (const hunk of patch) {
      const lines = (hunk as { lines?: unknown } | null)?.lines

      if (Array.isArray(lines)) {
        for (const line of lines) {
          if (typeof line === 'string' && line.startsWith('+')) {
            added += 1
          } else if (typeof line === 'string' && line.startsWith('-')) {
            removed += 1
          }
        }
      }
    }
  }

  return { added, removed }
}

/**
 * 【行為】從 Write、Edit、NotebookEdit 的參數和結果讀出這次改了哪個檔案、是不是新建、加減幾行。
 *   Write 的結果 type 是 create 算新建，加的行數是整個內容的行數；update 照 structuredPatch 數。
 *   Edit 照 structuredPatch 數。NotebookEdit 把新內容的行數算加、舊內容的行數算刪。
 *   其他工具、結果格式不對、找不到路徑，回 null。
 */
export function changeOf(tool: string, args: Readonly<Record<string, unknown>>, result: unknown): Change | null {
  if (typeof result !== 'object' || result === null) {
    return null
  }

  const r = result as Record<string, unknown>
  const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

  if (tool === 'Write') {
    const path = text(r.filePath) ?? text(args.file_path)

    if (path === undefined) {
      return null
    }

    if (r.type === 'create') {
      return { path, isNew: true, added: lineCountOf(text(r.content) ?? ''), removed: 0 }
    }

    return { path, isNew: false, ...patchCountOf(r.structuredPatch) }
  }

  if (tool === 'Edit') {
    const path = text(r.filePath) ?? text(args.file_path)

    return path === undefined ? null : { path, isNew: false, ...patchCountOf(r.structuredPatch) }
  }

  if (tool === 'NotebookEdit') {
    const path = text(r.notebook_path) ?? text(args.notebook_path)

    return path === undefined
      ? null
      : {
          path,
          isNew: false,
          added: lineCountOf(text(r.new_source) ?? ''),
          removed: lineCountOf(text(r.old_source) ?? ''),
        }
  }

  return null
}

/**
 * 【行為】從一段指令裡找出看起來像檔案路徑的字，回傳整理過的絕對路徑（不重複，最多 40 個）。
 *   看起來像路徑：含「/」，或結尾是「.副檔名」（副檔名以英文字母開頭，所以 v2.1.287 這種版本號不算）。網址、萬用字元、「-」開頭的選項、變數不算。
 *   指令裡有刪除或搬走的動詞（rm、rmdir、mv、del、rd、Remove-Item、Move-Item 這類，不分大小寫）時，
 *   沒有「/」也沒有副檔名的單字（rm -rf build 的 build）也算，因為被刪的常常是資料夾。
 *   「~」換成 home；相對路徑同時用 cwd 和指令裡每個「cd 資料夾」（也認 pushd、Set-Location）去接，因為不知道它是在哪一步之後用的。
 *   shell 是 'bash'（預設）時，帶「\\」的字只認磁碟機代號開頭的（C:\\a\\b），其他當作跳脫字元不算；
 *   是 'powershell' 時「\\」就是路徑分隔（.\\src\\a.ts 也算）。
 *   cwd 是磁碟機代號開頭時（Windows 上的 Git Bash），「/c/Users/…」這種寫法換成「C:/Users/…」。
 *   回傳時都整理成「/」隔開；Windows 路徑只差大小寫的算同一個，留第一次出現的寫法。
 *   找不到就回空陣列。這是猜的，不保證抓到全部，也可能多抓不存在的路徑（呼叫端去查存不存在）。
 */
export function pathsIn(command: string, cwd: string, home: string, shell: 'bash' | 'powershell' = 'bash'): string[] {
  const tokens = command
    .split(/[\s'"`=(),;|&<>{}[\]]+/)
    .map(token => token.replace(/^[:@]+|[.:]+$/g, ''))
    // bash 裡有「\\」的通常是跳脫字元，不當路徑；只有 Windows 磁碟機代號開頭（C:\\…）的例外
    .filter(
      token =>
        token !== '' &&
        !token.startsWith('-') &&
        !token.includes('://') &&
        !/[*?$]/.test(token) &&
        (shell === 'powershell' || !token.includes('\\') || /^[A-Za-z]:\\/.test(token)),
    )
  const hasDrive = /^[A-Za-z]:\//.test(cwd)
  const expand = (token: string) => {
    if (token === '~' || token.startsWith('~/') || token.startsWith('~\\')) {
      return `${home}${token.slice(1)}`
    }

    // Git Bash 的 /c/Users/… 就是 C:/Users/…
    return hasDrive ? token.replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`) : token
  }
  const bases = [cwd]
  const words = command.split(/\s+/)
  const removes = words.some(word => REMOVE_VERBS.has(word.toLowerCase()))

  for (let at = 0; at < words.length - 1; at += 1) {
    if (CD_VERBS.has((words[at] ?? '').toLowerCase())) {
      const target = expand((words[at + 1] ?? '').replace(/^['"]|['";&|]+$/g, ''))

      if (target !== '' && !target.startsWith('-')) {
        bases.push(normalize(isAbsolute(target) ? target : `${cwd}/${target}`))
      }
    }
  }

  const found = new Map<string, string>()
  const add = (path: string) => {
    if (!found.has(keyOf(path))) {
      found.set(keyOf(path), path)
    }
  }

  for (const raw of tokens) {
    const token = expand(raw)
    const isPathy =
      token.includes('/') ||
      token.includes('\\') ||
      /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(token) ||
      (removes && !REMOVE_VERBS.has(token.toLowerCase()))

    if (!isPathy || /^\d+(\.\d+)*$/.test(token)) {
      continue
    }

    if (isAbsolute(token)) {
      add(normalize(token))
    } else {
      for (const base of bases) {
        add(normalize(`${base}/${token}`))
      }
    }

    if (found.size >= MAX_CANDIDATES) {
      break
    }
  }

  return [...found.values()].slice(0, MAX_CANDIDATES)
}

/**
 * 【行為】比對指令跑之前和之後查到的狀態（見 Seen），回傳有變動的。不知道行數，所以 added、removed 都是 0。
 *   檔案：之前沒有、之後有的算新建；兩邊都有但修改時間不同的算修改；之前有、之後沒有的算刪掉（isGone）。
 *   資料夾：只回報「之前是資料夾、之後不見了」，算刪掉並標 isDir；新建資料夾、資料夾裡面的變動都不回報。
 *   after 裡沒有的路徑當作不存在。
 */
export function commandChangesOf(before: ReadonlyMap<string, Seen>, after: ReadonlyMap<string, Seen>): Change[] {
  const changes: Change[] = []

  for (const [path, then] of before) {
    const now = after.get(path) ?? null

    if (then === 'dir' || now === 'dir') {
      if (then === 'dir' && now === null) {
        changes.push({ path, isNew: false, added: 0, removed: 0, isGone: true, isDir: true })
      }

      continue
    }

    if (now === null) {
      if (then !== null) {
        changes.push({ path, isNew: false, added: 0, removed: 0, isGone: true })
      }

      continue
    }

    if (then === null || then !== now) {
      changes.push({ path, isNew: then === null, added: 0, removed: 0 })
    }
  }

  return changes
}

/** 【行為】路徑開頭是 home 的換成「~」；Windows 的「\\」先換成「/」再比對。home 要是 normalize 過的。 */
export function tildeOf(path: string, home: string): string {
  const posix = path.replace(/\\/g, '/')

  return home !== '' && (posix === home || posix.startsWith(`${home}/`)) ? `~${posix.slice(home.length)}` : path
}

/** 寬度不一定的字，左邊補空白補到 width 格寬。 */
function padStartWidth(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - widthOf(text))) + text
}

/** 左邊幾段字由左到右排、超過就裁；有 right 就靠右放，中間補空白，整行剛好 columns 格寬。 */
function line(left: Segment[], right: Segment | undefined, columns: number): Line {
  const room = right === undefined ? columns : Math.max(0, columns - widthOf(right.text) - 1)
  const kept: Segment[] = []
  let used = 0

  for (const segment of left) {
    if (room - used <= 0) {
      break
    }

    const text = fit(segment.text, room - used, segment.keepTail === true)

    if (text !== '') {
      kept.push({ ...segment, text })
      used += widthOf(text)
    }
  }

  if (right === undefined) {
    return kept
  }

  return [...kept, { text: ' '.repeat(Math.max(1, columns - used - widthOf(right.text))) }, right]
}

function numbersOf(row: FileRow): string {
  if (!row.hasCounts) {
    return '指令改的'
  }

  if (row.added === 0 && row.removed === 0) {
    return '±0'
  }

  return [row.added > 0 ? `+${row.added}` : '', row.removed > 0 ? `−${row.removed}` : ''].filter(Boolean).join(' ')
}

function relativeOf(path: string, root: string): string {
  return keyOf(path).startsWith(`${keyOf(root)}/`) ? path.slice(root.length + 1) : path
}

/**
 * 【何時能呼叫】columns 至少 30 才排得好看；更窄也不會壞，只是字會被裁掉。
 * 【行為】把檔案清單排成側邊欄的每一行，每一行都不超過 columns 格寬。
 *   第一行是標題，右邊寫新建、修改、刪掉各幾個（刪掉的不算進前兩個）。沒有檔案時只多一行「還沒有改過檔案」。
 *   依 root 分組：root 是 cwd 的那一組排第一、標成「這個資料夾（路徑）」，其他組照最近改動的時間排，標成資料夾路徑；
 *   組內也是最近改的在前。每個檔案一行：「新」「改」「刪」、相對於 root 的路徑（太長留結尾；資料夾結尾加「/」；
 *   Windows 路徑比對 root 時不分大小寫）、
 *   加減幾行（只被指令改過的寫「指令改的」）、改過幾次（幫手改的改寫幫手種類）。刪掉的整行變暗。
 *   最後一行寫最後一次修改的是哪個檔案、多久以前（now 減 lastAt）。home 用來把路徑寫成「~」開頭。
 */
export function linesOf(rows: readonly FileRow[], cwd: string, home: string, now: number, columns: number): Line[] {
  const created = rows.filter(row => !row.isGone && row.kind === 'new').length
  const changed = rows.filter(row => !row.isGone && row.kind === 'changed').length
  const gone = rows.filter(row => row.isGone).length
  const lines: Line[] = [
    line(
      [{ text: '檔案', bold: true }],
      { text: `新建 ${created}・修改 ${changed}・刪掉 ${gone}`, dim: true },
      columns,
    ),
  ]

  if (rows.length === 0) {
    lines.push([], [{ text: fit('這次對話還沒有改過檔案', columns), dim: true }])

    return lines
  }

  const groups = new Map<string, FileRow[]>()

  for (const row of [...rows].sort((a, b) => b.lastAt - a.lastAt)) {
    groups.set(row.root, [...(groups.get(row.root) ?? []), row])
  }

  const order = [...groups.keys()].sort((a, b) => Number(b === cwd) - Number(a === cwd))

  for (const root of order) {
    const title = root === cwd ? `這個資料夾（${tildeOf(root, home)}）` : `${tildeOf(root, home)}/`

    lines.push([], [{ text: fit(title, columns, root !== cwd), bold: true }])

    for (const row of groups.get(root) ?? []) {
      const mark: Segment = row.isGone
        ? { text: '刪', color: GONE, dim: true }
        : row.kind === 'new'
          ? { text: '新', color: NEW }
          : { text: '改', color: CHANGED }
      const tail = row.who ?? `${row.count} 次`
      const right: Segment = {
        text: `${padStartWidth(numbersOf(row), 9)}  ${padStartWidth(tail, 5)}`,
        ...(row.isGone ? { dim: true } : {}),
        ...(row.who === undefined || row.isGone ? {} : { color: HELPER }),
      }

      lines.push(
        line(
          [
            { text: '  ' },
            mark,
            { text: ' ' },
            {
              text: `${relativeOf(row.path, root)}${row.isDir === true ? '/' : ''}`,
              keepTail: true,
              ...(row.isGone ? { dim: true } : {}),
            },
          ],
          right,
          columns,
        ),
      )
    }
  }

  const last = rows.reduce((a, b) => (b.lastAt > a.lastAt ? b : a))

  lines.push(
    [],
    line(
      [{ text: '最後一次修改：', dim: true }, { text: relativeOf(last.path, last.root), keepTail: true, dim: true }],
      { text: agoOf(now - last.lastAt), dim: true },
      columns,
    ),
  )

  return lines
}

// #region AI-NOTES
// AI-NOTES：agent 專用備忘。當時為真、非契約、非指令；改到相關程式碼時重驗，錯了就刪。
// 2026-10-03 為了在原生 Windows 的 Claude Code 上跑，normalize、isAbsolute、isRoot、tildeOf、pathsIn 都認得「\\」和磁碟機代號；
//   內部一律存成「/」隔開、C:/ 開頭的寫法。沒有 Windows 機器可實測，只有單元測試；主人在 Windows 上看到路徑怪怪的先查這裡。
// 2026-10-03 Write、Edit 的結果格式看 .claude-plugin/types/claude-code-tools/index.d.ts（Write 有 type create|update、
//   兩者都有 structuredPatch，lines 以「+」「-」「 」開頭）；NotebookEdit 沒有 patch，只能用新舊內容的行數粗算。
// 2026-10-03 pathsIn 是猜的：同一個相對路徑會用 cwd 和每個 cd 目標各接一次，多抓的不存在路徑由呼叫端 stat 過濾。
//   主人的 Python heredoc 寫法（p='register.ts'、expanduser('~/.claude/settings.json')）都切得出來，是刻意照這個測的。
// 2026-10-03 有刪除動詞時連 ls、git 這種單字也會被當路徑去 stat（rm -rf build 的 build 沒副檔名，分不出來），
//   不存在就是兩邊都 null、不回報，只多花幾次 stat；上限還是 40 個。
// 2026-10-03 widthOf、fit、agoOf 從 ~/Workspace/projects/ctx-panel 複製（另一份來源 crew 已在 2026-10-03 刪掉）；mod 之間不能互相 import。
// #endregion
