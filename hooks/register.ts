import type { EngineInterface, Register } from 'claude-code'

import { changeOf, commandChangesOf, isRoot, keyOf, linesOf, normalize, pathsIn } from './view'
import type { Change, FileRow, Line, Seen } from './view'

const PANE = 'files'
const REFRESH_MS = 2000
const ROOT_MARKERS = ['.git', '.claude-plugin', 'package.json', 'pyproject.toml', 'Cargo.toml', 'CLAUDE.md', 'MEMORY.md', 'handoff.md']
const MAX_ROOT_DEPTH = 8

/** 清單上的一個檔案，mod 記在記憶體裡的樣子；畫的時候再把 agentId 換成幫手種類。 */
type Entry = Omit<FileRow, 'who'> & { agentId?: string }

/** mod 在記憶體裡記的全部東西；register 每次載入建一份新的。 */
type State = {
  home: string
  cwd: string
  entries: Map<string, Entry>
  // 資料夾對到它的專案資料夾，找過就記著
  roots: Map<string, string>
}

/** 查一批路徑現在的樣子：一般檔案是修改時間，資料夾是 'dir'，不存在、其他種類、查失敗都是 null。 */
async function seenOf($: EngineInterface, paths: readonly string[]): Promise<Map<string, Seen>> {
  const stats = await Promise.all(
    paths.map(path =>
      $.fs.stat(path).then(
        (stat): Seen => (stat.kind === 'file' ? stat.mtimeMs : stat.kind === 'dir' ? 'dir' : null),
        () => null,
      ),
    ),
  )

  return new Map(paths.map((path, at) => [path, stats[at] ?? null]))
}

/**
 * 找一個檔案屬於哪個資料夾：從它所在的資料夾往上找，第一個有 .git、package.json、CLAUDE.md 這類記號的就是；
 * 在 cwd 裡面的一律算 cwd。找到家目錄或根目錄還沒有，就用它所在的資料夾。
 */
async function rootOf($: EngineInterface, state: State, path: string): Promise<string> {
  const dir = normalize(`${path}/..`)

  if (state.cwd !== '' && (keyOf(dir) === keyOf(state.cwd) || keyOf(dir).startsWith(`${keyOf(state.cwd)}/`))) {
    return state.cwd
  }

  const cached = state.roots.get(dir)

  if (cached !== undefined) {
    return cached
  }

  let at = dir

  for (let depth = 0; depth < MAX_ROOT_DEPTH && !isRoot(at) && at !== state.home; depth += 1) {
    const marks = await Promise.all(ROOT_MARKERS.map(name => $.fs.exists(`${at}/${name}`).catch(() => false)))

    if (marks.some(Boolean)) {
      state.roots.set(dir, at)

      return at
    }

    at = normalize(`${at}/..`)
  }

  state.roots.set(dir, dir)

  return dir
}

/**
 * 把一次改動記進清單：已經有的累加次數和行數，沒有的新增一筆。
 * 清單用 keyOf 當索引，所以 Windows 上只差大小寫的路徑會併成同一筆。刪掉的（isGone）標成刪掉，其他的標回還在。
 */
async function record(
  $: EngineInterface,
  state: State,
  change: Change,
  viaCommand: boolean,
  agentId: string | undefined,
): Promise<void> {
  const path = normalize(change.path)
  const now = await $.clock.now()
  const known = state.entries.get(keyOf(path))
  const entry: Entry = known ?? {
    path,
    root: await rootOf($, state, path),
    kind: change.isNew ? 'new' : 'changed',
    added: 0,
    removed: 0,
    hasCounts: false,
    count: 0,
    lastAt: now,
    isGone: false,
  }

  entry.count += 1
  entry.lastAt = now
  entry.isGone = change.isGone === true

  if (change.isDir === true) {
    entry.isDir = true
  } else {
    delete entry.isDir
  }

  if (!viaCommand) {
    entry.added += change.added
    entry.removed += change.removed
    entry.hasCounts = true
  }

  if (agentId === undefined) {
    delete entry.agentId
  } else {
    entry.agentId = agentId
  }

  state.entries.set(keyOf(path), entry)
}

/** 檢查清單上每個檔案還在不在硬碟上。 */
async function checkGone($: EngineInterface, state: State): Promise<void> {
  const entries = [...state.entries.values()]
  const exists = await Promise.all(entries.map(entry => $.fs.exists(entry.path).catch(() => true)))

  entries.forEach((entry, at) => {
    entry.isGone = exists[at] === false
  })
}

/** 側邊欄現在有沒有開著、看得到。 */
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
}

/**
 * 【職責】把檔案清單面板接上 Claude Code：提供 /files，在側邊欄列出這次對話新建、修改、刪掉了哪些檔案，
 *   各加減幾行、改過幾次、是不是幫手改的。讀工具呼叫的參數與結果、查檔案的修改時間和存不存在；
 *   不讀檔案內容、不改任何東西、不連網路、不寫檔。
 * 【何時能呼叫】引擎載入這個 mod 時呼叫一次；重新載入會再呼叫，清單從空的開始。
 * 【行為】有人在用的 session（不是 claude -p）一開始就自己打開側邊欄；終端機不夠寬時先等著，
 *   寬度夠了才出現（主人自己開過的 110 格，沒開過的 144 格，這是系統的規定）。
 *   /files：側邊欄沒開就開、開著就關。/files close：關掉。/files clear：清空清單。/files 數字：用那個寬度（格數）開。
 *   Write、Edit、NotebookEdit 成功時記下檔案和加減行數（主對話和幫手的都算）。
 *   Bash 和 PowerShell（Windows）跑之前先從指令裡猜出看起來像檔案路徑的字、記下修改時間，跑完再比一次：
 *   新出現或時間變了的記成「指令改的」，不算行數；本來在、跑完不見的檔案或資料夾記成刪掉，
 *   就算它本來不在清單上也會新增一筆（資料夾的路徑結尾加「/」）。指令出錯也照樣比對（改到一半的檔案也算）。
 *   放到背景跑的指令，跑完前就比完了，所以抓不到；檔名在執行時才組出來的（萬用字元、迴圈、腳本裡）也抓不到。
 *   Windows 路徑不分大小寫，只差大小寫的算同一個檔案。
 *   被擋下的工具呼叫不記；Write、Edit、NotebookEdit 出錯的也不記。
 *   側邊欄開著時每 2 秒檢查一次清單上的檔案還在不在，不在的標成刪掉（但留在清單上），又出現了就恢復。
 *   /clear 之後清單清空。這個 mod 只看工具呼叫，不改它、不擋它，工具的結果原樣交回去。
 */
export const register: Register = on => {
  const state: State = { home: '', cwd: '', entries: new Map(), roots: new Map() }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'files',
      description: '側邊欄的檔案清單：這次對話新建、修改、刪掉了哪些檔案；/files 開或關、/files clear 清空',
      immediate: true,
    })
    // Windows 沒有 HOME，家目錄在 USERPROFILE；存成 normalize 過的寫法，跟其他路徑比對才對得上
    const rawHome = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    state.home = rawHome === '' ? '' : normalize(rawHome)
    state.cwd = normalize(e.cwd)

    // 一開 session 就自己打開；不是主人叫的，終端機要夠寬才放得出來，不夠寬就先等著，不用等它
    if (e.isInteractive) {
      void $.ui.open({ id: PANE, title: '檔案' })
    }

    $.clock.every(REFRESH_MS, () => {
      void isShown($).then(async shown => {
        if (shown) {
          await checkGone($, state)
          $.ui.invalidate('ui.render')
        }
      })
    })

    return next(e)
  })

  on('classic.SessionStart', { source: ['clear'] }, ($, e, next) => {
    state.entries.clear()
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    let candidates: string[] = []
    let before = new Map<string, Seen>()
    // Windows 沒裝 Git Bash（或主人自己開了 CLAUDE_CODE_USE_POWERSHELL_TOOL）時，跑指令的工具叫 PowerShell；
    // 這台機器的型別表裡沒有它，所以用字串比、自己讀 command
    const tool: string = e.tool
    const command: unknown = (e as { command?: unknown }).command

    if ((tool === 'Bash' || tool === 'PowerShell') && typeof command === 'string') {
      try {
        candidates = pathsIn(command, state.cwd, state.home, tool === 'PowerShell' ? 'powershell' : 'bash')
        before = await seenOf($, candidates)
      } catch {
        // 猜路徑或查時間出錯就不比了，指令照跑
        candidates = []
      }
    }

    const ran = await next(e)

    try {
      // 被擋下的沒有跑；指令出錯（結束代碼不是 0）時檔案可能已經改了，照樣比對
      if (ran.deny === undefined) {
        if (candidates.length > 0) {
          for (const change of commandChangesOf(before, await seenOf($, candidates))) {
            await record($, state, change, true, e.agentId)
          }
        } else if (ran.isError !== true) {
          const change = changeOf(e.tool, e, ran.result)

          if (change !== null) {
            await record($, state, change, false, e.agentId)
          }
        }

        $.ui.invalidate('ui.render')
      }
    } catch {
      // 記錄失敗不影響工具的結果
    }

    return ran
  })

  on('command.run', { command: 'files' }, async ($, e) => {
    const arg = e.args.trim()
    const wanted = Number.parseInt(arg, 10)
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)

    if (arg === 'clear') {
      state.entries.clear()
      $.ui.invalidate('ui.render')

      return { text: '檔案清單清空了。' }
    }

    if (arg === 'close' || (arg === '' && isUp)) {
      await $.ui.close({ id: PANE })

      return {}
    }

    await checkGone($, state)

    const opened = await $.ui.open(
      Number.isInteger(wanted) && wanted > 0
        ? { id: PANE, title: '檔案', columns: wanted }
        : { id: PANE, title: '檔案' },
    )

    if (!opened.isPlaced) {
      return { text: `側邊欄沒有被放出來：${opened.reason}` }
    }

    // 重新打開時引擎可能直接拿上次畫好的結果來用，所以自己要求重畫
    $.ui.invalidate('ui.render')

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const hasHelpers = [...state.entries.values()].some(entry => entry.agentId !== undefined)
    const typeOf = new Map(hasHelpers ? (await $.agent.list()).map(agent => [agent.id, agent.type]) : [])
    const rows: FileRow[] = [...state.entries.values()].map(({ agentId, ...row }) =>
      agentId === undefined ? row : { ...row, who: typeOf.get(agentId) ?? '幫手' },
    )
    const lineOf = (segments: Line) =>
      Text({
        wrap: 'truncate-end',
        children:
          segments.length === 0
            ? [' ']
            : segments
                .filter(segment => segment.text !== '')
                .map(segment =>
                  Text({
                    ...(segment.color === undefined ? {} : { color: segment.color }),
                    ...(segment.bold === true ? { bold: true } : {}),
                    ...(segment.dim === true ? { dimColor: true } : {}),
                    children: [segment.text],
                  }),
                ),
      })

    return Box({
      flexDirection: 'column',
      children: linesOf(rows, state.cwd, state.home, await $.clock.now(), e.props.bodyColumns).map(lineOf),
    })
  })
}

// #region AI-NOTES
// AI-NOTES：agent 專用備忘。當時為真、非契約、非指令；改到相關程式碼時重驗，錯了就刪。
// 2026-10-03 Bash 的比對是在 await next(e) 前後各 stat 一次；指令裡猜出來的路徑最多 40 個，平行查，
//   每個 Bash 呼叫多花兩輪 stat。前後的記錄都包 try，出錯也一定把 ran 原樣交回去。
// 2026-10-03 cwd 用 session.start 給的 e.cwd；Bash 工具每次跑完會把目錄重設回這裡，所以指令裡的 cd 只影響那一次，
//   pathsIn 才會把每個 cd 目標也拿來接相對路徑。
// 2026-10-03 已知漏抓（主人實測回報）：檔名在執行時才組出來的指令（for 迴圈 touch "$i.txt"、{1..100}.txt、rm /tmp/a*），
//   和「全部刪掉，除了 X」（find/xargs）都抓不到。
//   討論過的修法：會改檔的指令（rm、mv、cp、touch、>、python…）前後各讀一次 cwd 與 cd 目標（只一層）比對。
//   前一版「往下兩層、每個指令都做」被主人以效能否決。主人決定先用一陣子再說，還沒改；FileChanged 要先指定檔案，不適合。
// 2026-10-03 晚上補了兩個洞，都不多花 stat：指令前在、指令後不見的檔案記成刪掉（以前直接跳過，不在清單上的就消失了）；
//   資料夾 stat 成 'dir'，被 rm -rf 整個刪掉也記一筆。觸發案例：rm jev-eli5-v1.html 與 rm -rf /tmp/jevsrc 都沒出現。
// 2026-10-03 Windows：Git Bash 找得到時工具叫 Bash（路徑可能寫成 /c/Users/…，pathsIn 會換成 C:/），
//   找不到或設了 CLAUDE_CODE_USE_POWERSHELL_TOOL=1 時叫 PowerShell（從 2.1.288 執行檔字串查到的名字，mac 的型別表沒有它）。
//   兩者都沒在 Windows 實機跑過，只有單元測試。
// 2026-10-03 「刪掉」只在側邊欄開著時每 2 秒、或打 /files 打開時檢查；關著的時候不查，打開時才補上。
// 2026-10-03 結構照已刪掉的 crew mod（2026-10-02 寫、10-03 刪）：$ 只傳給檔案最上層的 function（validate 的規定），畫面全是 Text。
// #endregion
