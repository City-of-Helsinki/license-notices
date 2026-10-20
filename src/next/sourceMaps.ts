import fs from 'node:fs';
import path from 'node:path';

import { compareCodeUnits } from '../core.js';

/**
 * Reads which source files have output in a client build, from the source
 * maps next to its chunks. Turbopack has no plugin API that reports the
 * modules of a chunk, and its chunks name modules by number only, so the
 * source maps are the one record of what a chunk was built from.
 */

type SourceMap = {
  sources?: (string | null)[];
  sourceRoot?: string;
  mappings?: string;
  sections?: { map: SourceMap }[];
};

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Map([...BASE64].map((char, i) => [char, i]));

/** The base64 VLQ values of one segment of the mappings of a source map. */
function decodeSegment(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64_VALUES.get(char);
    if (digit === undefined) {
      throw new Error(`Invalid character "${char}" in source map mappings.`);
    }
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

/**
 * The indices of the sources that at least one segment of the mappings maps
 * output to. A source listed without any, such as a module whose code was
 * all removed, contributes nothing to the chunk, like a module that Rollup
 * reports with no rendered length.
 */
export function findMappedSourceIndices(mappings: string): Set<number> {
  const mapped = new Set<number>();
  // The source index is relative to the previous segment that has one,
  // across lines too.
  let source = 0;
  for (const line of mappings.split(';')) {
    for (const segment of line.split(',')) {
      if (segment.length === 0) {
        continue;
      }
      const values = decodeSegment(segment);
      if (values.length >= 4) {
        source += values[1];
        mapped.add(source);
      }
    }
  }
  return mapped;
}

/** The sources of a source map that have output, indexed maps included. */
export function findMappedSources(map: SourceMap): string[] {
  if (map.sections) {
    return map.sections.flatMap((section) => findMappedSources(section.map));
  }
  const mapped = findMappedSourceIndices(map.mappings ?? '');
  return (map.sources ?? []).flatMap((source, i) => {
    if (source === null || !mapped.has(i)) {
      return [];
    }
    return [map.sourceRoot ? `${map.sourceRoot}${source}` : source];
  });
}

/**
 * The URL of the source map a chunk names in the comment on its last line,
 * if any. Only that line is read, since the same words can appear in the
 * code of a chunk as well.
 */
export function findSourceMapUrl(code: string): string | undefined {
  const trimmed = code.trimEnd();
  const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
  for (const prefix of ['//# ', '//@ ', '/*# ', '/*@ ']) {
    if (lastLine.startsWith(`${prefix}sourceMappingURL=`)) {
      const url = lastLine
        .slice(prefix.length + 'sourceMappingURL='.length)
        .split(/[\s*]/, 1)[0];
      return url || undefined;
    }
  }
  return undefined;
}

function readSourceMap(file: string, url: string): SourceMap {
  const inline = /^data:application\/json[^,]*;base64,/.exec(url);
  const json = inline
    ? Buffer.from(url.slice(inline[0].length), 'base64').toString('utf8')
    : fs.readFileSync(
        path.resolve(path.dirname(file), decodeURIComponent(url)),
        'utf8'
      );
  return JSON.parse(json) as SourceMap;
}

function listFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? listFiles(path.join(dir, entry.name))
        : [path.join(dir, entry.name)]
    );
}

export type ClientSources = {
  /** Every source with output in a chunk, as its source map names it. */
  sources: string[];
  /** How many chunks name a source map, so that none at all can be told. */
  mappedChunks: number;
};

/**
 * The sources with output in the JavaScript and CSS chunks of a directory,
 * read from the source maps the chunks name. A chunk without one, such as
 * the small loaders that only list the chunks of a page, is skipped.
 */
export function readClientSources(staticDir: string): ClientSources {
  const sources = new Set<string>();
  let mappedChunks = 0;
  const chunks = listFiles(staticDir)
    .filter((file) => /\.(js|css)$/.test(file))
    .sort(compareCodeUnits);
  for (const chunk of chunks) {
    const url = findSourceMapUrl(fs.readFileSync(chunk, 'utf8'));
    if (url === undefined) {
      continue;
    }
    mappedChunks += 1;
    for (const source of findMappedSources(readSourceMap(chunk, url))) {
      sources.add(source);
    }
  }
  return { sources: [...sources].sort(compareCodeUnits), mappedChunks };
}
