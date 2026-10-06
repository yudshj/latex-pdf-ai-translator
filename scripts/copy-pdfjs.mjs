import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'node_modules', 'pdfjs-dist')
const target = join(root, 'media', 'pdfjs')

await mkdir(target, { recursive: true })
for (const [from, to] of [
    ['build/pdf.min.mjs', 'pdf.min.mjs'],
    ['build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
    ['web/pdf_viewer.css', 'pdf_viewer.css'],
    ['LICENSE', 'LICENSE'],
]) {
    await cp(join(source, from), join(target, to))
}
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
    await cp(join(source, directory), join(target, directory), { recursive: true, force: true })
}
