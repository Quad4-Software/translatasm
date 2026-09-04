/**
 * Shared translation types.
 */

/**
 * @typedef {object} ModelInfo
 * @property {string} id
 * @property {string} label
 * @property {string} engine
 * @property {string} path
 * @property {string} from
 * @property {string} to
 * @property {string} [architecture]
 * @property {number} size_hint_mb
 * @property {string} [notes]
 * @property {boolean} [default]
 */

/**
 * @typedef {object} LanguageInfo
 * @property {string} code
 * @property {string} label
 */

/**
 * @typedef {object} ProgressEvent
 * @property {string} [status]
 * @property {number} [progress]
 * @property {string} [file]
 */

/**
 * @typedef {object} TranslateOptions
 * @property {string} [from]
 * @property {string} [to]
 * @property {boolean} [html]
 * @property {boolean} [incremental]
 * @property {number} [chunkChars]
 * @property {AbortSignal} [signal]
 * @property {(ev: ProgressEvent) => void} [onProgress]
 * @property {(partial: TranslateResult) => void} [onPartial]
 */

/**
 * @typedef {{source: string, target: string}} AlignedSentence
 */

/**
 * @typedef {object} TranslateResult
 * @property {string} text
 * @property {string} from
 * @property {string} to
 * @property {AlignedSentence[]} [sentences]
 */

/**
 * @typedef {object} Engine
 * @property {string} id
 * @property {(model: ModelInfo, onProgress?: (ev: ProgressEvent) => void) => Promise<void>} load
 * @property {(text: string, opts?: TranslateOptions) => Promise<TranslateResult>} translate
 * @property {(from: string, to: string, onProgress?: (ev: ProgressEvent) => void) => Promise<void>} [prefetch]
 * @property {() => void} dispose
 */
