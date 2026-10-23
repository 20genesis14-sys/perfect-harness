// File-backed lesson store — adapter layer (I/O allowed here, never in core).
// The session-log plugin-record seam is good for audit but bad for retrieval:
// a lesson library must survive across sessions and be readable before the
// next propose. A plain JSON file beside the working dir is the honest
// default backend for any host.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createLibrary, libraryFromJSON } from '../core/lessons.js'

/**
 * @param {string} path JSON file location (created on first save)
 * @returns {object} {load(), save(library)}
 */
export function createFileLessonStore(path) {
  return {
    path,
    /** Missing/corrupt file degrades to an empty library — never throws. */
    async load() {
      try {
        return libraryFromJSON(JSON.parse(await readFile(path, 'utf8')))
      } catch {
        return createLibrary()
      }
    },
    async save(library) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(library.toJSON(), null, 2))
      return true
    },
  }
}
