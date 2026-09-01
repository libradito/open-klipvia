/** Where rendered and exported files live. One definition, used everywhere. */
import { join } from 'node:path'

export const EXPORT_DIR = join(process.cwd(), 'data', 'exports')
