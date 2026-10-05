import { expect, mock, test } from 'claude-code/testing'

import { changeOf, commandChangesOf, isAbsolute, isRoot, keyOf, lineCountOf, linesOf, normalize, pathsIn, tildeOf, widthOf } from '../hooks/view'
import type { FileRow, Line, Seen } from '../hooks/view'

const HOME = '/Users/someone'
const CWD = `${HOME}/work`

function textOf(line: Line): string {
  return line.map(segment => segment.text).join('')
}

test('讀得懂 Write、Edit、NotebookEdit 的結果', async () => {
  expect(lineCountOf('')).toBe(0)
  expect(lineCountOf('a\nb\n')).toBe(2)
  expect(lineCountOf('a\nb')).toBe(2)
  expect(changeOf('Write', {}, { type: 'create', filePath: '/a.ts', content: 'x\ny\nz\n', structuredPatch: [] })).toEqual({
    path: '/a.ts',
    isNew: true,
    added: 3,
    removed: 0,
  })
  expect(
    changeOf('Edit', {}, { filePath: '/b.ts', structuredPatch: [{ lines: [' keep', '-old', '+new', '+more'] }] }),
  ).toEqual({ path: '/b.ts', isNew: false, added: 2, removed: 1 })
  expect(
    changeOf('Write', {}, { type: 'update', filePath: '/c.ts', structuredPatch: [{ lines: ['-a'] }, { lines: ['+b'] }] }),
  ).toEqual({ path: '/c.ts', isNew: false, added: 1, removed: 1 })
  expect(changeOf('NotebookEdit', {}, { notebook_path: '/n.ipynb', new_source: 'a\nb', old_source: 'a' })).toEqual({
    path: '/n.ipynb',
    isNew: false,
    added: 2,
    removed: 1,
  })
  expect(changeOf('Read', {}, { filePath: '/a.ts' })).toBeNull()
  expect(changeOf('Edit', {}, null)).toBeNull()
})

test('從指令裡猜出檔案路徑：heredoc、cd、~、相對路徑都接得起來，網址和選項不算', async () => {
  expect(normalize('/a//b/./c/../d/')).toBe('/a/b/d')

  const settings = pathsIn(
    "python3 - <<'EOF'\nimport os\np=os.path.expanduser('~/.claude/settings.json')\nEOF",
    CWD,
    HOME,
  )

  expect(settings).toContain(`${HOME}/.claude/settings.json`)

  const edit = pathsIn("cd ~/proj/hooks && python3 - <<'EOF'\np='register.ts'\nopen(p).read()\nEOF", CWD, HOME)

  expect(edit).toContain(`${HOME}/proj/hooks/register.ts`)
  expect(edit).toContain(`${CWD}/register.ts`)

  const copy = pathsIn('cp notes.md /tmp/out.png && curl -sL https://x.com/a.js -o page.html --max-time 30 *.ts v2.1.287', CWD, HOME)

  expect(copy).toEqual([`${CWD}/notes.md`, '/tmp/out.png', `${CWD}/page.html`])
  expect(pathsIn('ls -la', CWD, HOME)).toEqual([])

  const before = new Map<string, number | null>([
    ['/a', null],
    ['/b', 100],
    ['/c', 100],
    ['/d', null],
  ])
  const after = new Map<string, number | null>([
    ['/a', 5],
    ['/b', 200],
    ['/c', 100],
    ['/d', null],
  ])

  expect(commandChangesOf(before, after)).toEqual([
    { path: '/a', isNew: true, added: 0, removed: 0 },
    { path: '/b', isNew: false, added: 0, removed: 0 },
  ])
})

test('清單每一行都不超過寬度，分組、標記、數字都對', async () => {
  const rows: FileRow[] = [
    { path: `${CWD}/demo.html`, root: CWD, kind: 'new', added: 380, removed: 0, hasCounts: true, count: 1, who: 'Plan', lastAt: 1000, isGone: true },
    { path: `${HOME}/proj/hooks/register.ts`, root: `${HOME}/proj`, kind: 'new', added: 318, removed: 24, hasCounts: true, count: 4, lastAt: 9000, isGone: false },
    { path: `${HOME}/proj/hooks/view.ts`, root: `${HOME}/proj`, kind: 'new', added: 412, removed: 0, hasCounts: true, count: 2, lastAt: 5000, isGone: false },
    { path: `${HOME}/.claude/settings.json`, root: `${HOME}/.claude`, kind: 'changed', added: 0, removed: 0, hasCounts: false, count: 1, lastAt: 3000, isGone: false },
  ]

  for (const columns of [30, 47, 73]) {
    for (const line of linesOf(rows, CWD, HOME, 21_000, columns)) {
      expect(widthOf(textOf(line))).toBeLessThanOrEqual(columns)
    }
  }

  const lines = linesOf(rows, CWD, HOME, 21_000, 47).map(textOf)
  const all = lines.join('\n')

  expect(all).toContain('新建 2・修改 1・刪掉 1')
  expect(lines.indexOf('這個資料夾（~/work）')).toBeLessThan(lines.indexOf('~/proj/'))
  expect(lines.indexOf('~/proj/')).toBeLessThan(lines.indexOf('~/.claude/'))
  expect(all).toContain('刪 demo.html')
  expect(all).toContain('Plan')
  expect(all).toMatch(/新 hooks\/register\.ts +\+318 −24 +4 次/)
  expect(all).toContain('改 settings.json')
  expect(all).toContain('指令改的')
  expect(all).toContain('最後一次修改：hooks/register.ts')
  expect(all).toContain('12 秒前')
  expect(linesOf([], CWD, HOME, 0, 47).map(textOf).join('\n')).toContain('這次對話還沒有改過檔案')
})

test('Write、Edit、指令改的檔案都進清單，刪掉的標出來，/clear 清空', async ($, on) => {
  mock.clock(on)
  const files = new Map<string, number>([[`${HOME}/proj/hooks/register.ts`, 100]])
  const markers = new Set([`${HOME}/proj/.git`])
  const opened: string[] = []

  on('env.get', () => ({ value: HOME }))
  on('ui.invalidate', (_, e, next) => next(e))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [{ id: 'h1', description: '寫草稿', type: 'Plan', status: 'running' }] }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || markers.has(e.path) }))
  on('fs.stat', (_, e) => {
    const mtime = files.get(e.path)

    if (mtime === undefined) {
      throw new Error(`ENOENT ${e.path}`)
    }

    return { value: { kind: 'file' as const, size: 1, mtimeMs: mtime, isLink: false } }
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'Write') {
      files.set(String(e.file_path), 1)

      return { result: { type: 'create', filePath: e.file_path, content: 'a\nb\nc\n', structuredPatch: [] } as never }
    }

    if (e.tool === 'Edit') {
      return { result: { filePath: e.file_path, structuredPatch: [{ lines: ['-x', '+y', '+z'] }] } as never }
    }

    // Bash：模擬指令改了 register.ts、建了 out.png，最後一步出錯（結束代碼不是 0）
    files.set(`${HOME}/proj/hooks/register.ts`, 200)
    files.set(`${CWD}/out.png`, 1)

    return { result: { stdout: '', stderr: 'tsc failed', interrupted: false } as never, isError: true }
  })

  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(opened).toEqual(['files'])

  const ui = await $.ui.mount({
    plugin: 'files',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'files',
    props: {
      title: '檔案',
      isFocused: false,
      bodyColumns: 47,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 38 },
      view: {},
    },
  })

  expect(await ui.find({ type: 'Text', text: /還沒有改過檔案/ })).toBeDefined()

  await $.tool.call({ tool: 'Write', file_path: `${CWD}/notes.md`, content: 'a\nb\nc\n' } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/notes.md`, old_string: 'x', new_string: 'y\nz' } as never)
  await $.tool.call({ tool: 'Bash', command: "cd ~/proj/hooks && python3 - <<'EOF'\np='register.ts'\nEOF\ncp a out.png" } as never)

  expect(await ui.find({ type: 'Text', text: /新建 2・修改 1・刪掉 0/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /新 notes\.md +\+5 −1 +2 次/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /~\/proj\// })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /改 hooks\/register\.ts +指令改的 +1 次/ })).toBeDefined()

  files.delete(`${CWD}/notes.md`)
  await $.command.run({ command: 'files', args: '' } as never)
  expect(await ui.find({ type: 'Text', text: /刪 notes\.md/ })).toBeDefined()

  await $.command.run({ command: 'files', args: 'clear' } as never)
  expect(await ui.find({ type: 'Text', text: /還沒有改過檔案/ })).toBeDefined()

  await ui.unmount()
})

test('Windows 路徑：反斜線、磁碟機代號、家目錄都認得', () => {
  expect(normalize('C:\\Users\\jesse\\work\\..\\talk\\')).toBe('C:/Users/jesse/talk')
  expect(normalize('C:\\..')).toBe('C:/')
  expect(normalize('C:/')).toBe('C:/')
  expect(normalize('/a//b/./c/../d/')).toBe('/a/b/d')
  expect(normalize('rel\\x\\.\\y')).toBe('rel/x/y')
  expect(isAbsolute('C:\\x')).toBe(true)
  expect(isAbsolute('D:/x')).toBe(true)
  expect(isAbsolute('/x')).toBe(true)
  expect(isAbsolute('x/y')).toBe(false)
  expect(isRoot('C:/')).toBe(true)
  expect(isRoot('/')).toBe(true)
  expect(isRoot('C:/Users')).toBe(false)

  const winHome = 'C:/Users/jesse'
  expect(tildeOf('C:\\Users\\jesse\\work\\a.ts', winHome)).toBe('~/work/a.ts')
  expect(tildeOf('C:/Users/jesse2/a.ts', winHome)).toBe('C:/Users/jesse2/a.ts')
  expect(tildeOf('/Users/someone/x', '/Users/someone')).toBe('~/x')

  const found = pathsIn('type C:\\Users\\jesse\\work\\notes.md && cd D:\\proj && cat src/main.rs', 'C:/Users/jesse/work', winHome)
  expect(found).toContain('C:/Users/jesse/work/notes.md')
  expect(found).toContain('D:/proj/src/main.rs')
})

test('指令刪掉的檔案和資料夾：本來不在清單上的也記成刪掉', () => {
  const before = new Map<string, Seen>([
    ['/gone.html', 100],
    ['/tmp/jevsrc', 'dir'],
    ['/kept', 'dir'],
    ['/made', null],
    ['/never', null],
  ])
  const after = new Map<string, Seen>([
    ['/gone.html', null],
    ['/tmp/jevsrc', null],
    ['/kept', 'dir'],
    ['/made', 'dir'],
    ['/never', null],
  ])

  expect(commandChangesOf(before, after)).toEqual([
    { path: '/gone.html', isNew: false, added: 0, removed: 0, isGone: true },
    { path: '/tmp/jevsrc', isNew: false, added: 0, removed: 0, isGone: true, isDir: true },
  ])

  // 有刪除動詞時，沒有副檔名的單字也算；沒有時不算
  expect(pathsIn('rm -rf build && ls', CWD, HOME)).toEqual([`${CWD}/build`, `${CWD}/ls`])
  expect(pathsIn('echo build', CWD, HOME)).toEqual([])
  expect(pathsIn('Remove-Item -Recurse -Force dist', CWD, HOME, 'powershell')).toEqual([`${CWD}/dist`])

  const rows: FileRow[] = [
    { path: '/tmp/jevsrc', root: '/tmp', kind: 'changed', added: 0, removed: 0, hasCounts: false, count: 1, lastAt: 1000, isGone: true, isDir: true },
  ]
  expect(linesOf(rows, CWD, HOME, 2000, 47).map(textOf).join('\n')).toContain('刪 jevsrc/')
})

test('Windows 的指令：PowerShell 的反斜線、Git Bash 的 /c/、大小寫不同算同一個', () => {
  const cwd = 'C:/Users/Jesse/work'
  const home = 'C:/Users/Jesse'

  const ps = pathsIn('del .\\src\\a.ts; Set-Location ..\\talk; ri notes.md', cwd, home, 'powershell')

  expect(ps).toContain('C:/Users/Jesse/work/src/a.ts')
  expect(ps).toContain('C:/Users/Jesse/talk/notes.md')
  expect(pathsIn('rm /c/Users/Jesse/work/old.html ~/x.txt', cwd, home)).toEqual([
    'C:/Users/Jesse/work/old.html',
    'C:/Users/Jesse/x.txt',
  ])
  // mac／Linux 上 /c/ 就是 /c/，不換
  expect(pathsIn('cat /c/a.txt', CWD, HOME)).toEqual(['/c/a.txt'])
  // bash 裡的 \ 還是當跳脫字元
  expect(pathsIn('echo a\\b.txt', cwd, home)).toEqual([])
  expect(pathsIn('cat C:/Users/Jesse/A.ts c:/users/jesse/a.ts', cwd, home)).toEqual(['C:/Users/Jesse/A.ts'])
  expect(keyOf('C:/Users/Jesse/A.ts')).toBe('c:/users/jesse/a.ts')
  expect(keyOf('/Users/Jesse/A.ts')).toBe('/Users/Jesse/A.ts')
})

test('Windows 上跑：Write 建的檔案被 PowerShell 刪掉併成同一筆，Git Bash 刪的資料夾和檔案也出現', async ($, on) => {
  mock.clock(on)
  const cwd = 'C:/Users/Jesse/work'
  // 假的 Windows 硬碟：不分大小寫，所以用 keyOf 當索引
  const files = new Map<string, number>([[keyOf(`${cwd}/old.html`), 100]])
  const dirs = new Set([keyOf(`${cwd}/build`), keyOf(cwd), keyOf(`${cwd}/src`)])

  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\Jesse' : undefined }))
  on('ui.invalidate', (_, e, next) => next(e))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  // 測試在 mac 上跑時，引擎會把 C:/… 當相對路徑接在 mod 資料夾後面，先切回 C:/ 開頭
  const keyIn = (path: string) => keyOf(normalize(/[A-Za-z]:[\\/].*$/.exec(path)?.[0] ?? path))

  on('fs.exists', (_, e) => ({ value: files.has(keyIn(e.path)) || dirs.has(keyIn(e.path)) }))
  on('fs.stat', (_, e) => {
    const key = keyIn(e.path)
    const mtime = files.get(key)

    if (dirs.has(key)) {
      return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    }

    if (mtime === undefined) {
      throw new Error(`ENOENT ${e.path}`)
    }

    return { value: { kind: 'file' as const, size: 1, mtimeMs: mtime, isLink: false } }
  })
  on('tool.call', (_, e) => {
    const tool: string = e.tool

    if (tool === 'Write') {
      files.set(keyOf(normalize(String((e as { file_path?: unknown }).file_path))), 1)

      return { result: { type: 'create', filePath: (e as { file_path?: unknown }).file_path, content: 'a\nb\nc\n', structuredPatch: [] } as never }
    }

    if (tool === 'PowerShell') {
      files.delete(keyOf(`${cwd}/src/a.ts`))
      dirs.delete(keyOf(`${cwd}/build`))

      return { result: { stdout: '', stderr: '' } as never }
    }

    // Git Bash
    files.delete(keyOf(`${cwd}/old.html`))

    return { result: { stdout: '', stderr: '' } as never }
  })

  await $.session.start({ cwd: 'C:\\Users\\Jesse\\work', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'files',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'files',
    props: {
      title: '檔案',
      isFocused: false,
      bodyColumns: 47,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 38 },
      view: {},
    },
  })

  await $.tool.call({ tool: 'Write', file_path: 'C:\\Users\\Jesse\\work\\src\\a.ts', content: 'a\nb\nc\n' } as never)
  await $.tool.call({ tool: 'PowerShell', command: 'del c:\\users\\jesse\\work\\SRC\\A.ts; Remove-Item -Recurse -Force build' } as never)
  await $.tool.call({ tool: 'Bash', command: 'rm /c/Users/Jesse/work/old.html' } as never)

  expect(await ui.find({ type: 'Text', text: /新建 0・修改 0・刪掉 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /這個資料夾（~\/work）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /刪 src\/a\.ts +\+3 +2 次/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /刪 build\/ +指令改的 +1 次/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /刪 old\.html +指令改的 +1 次/ })).toBeDefined()

  await ui.unmount()
})
