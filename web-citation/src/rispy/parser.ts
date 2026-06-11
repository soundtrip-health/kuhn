import { DELIMITED_TAG_MAPPING, LIST_TYPE_TAGS, TAG_KEY_MAPPING, type RisRecord } from "./config.js";

type UnknownTagMap = Record<string, string[]>;

export interface RisParserOptions {
  mapping?: Record<string, string>;
  listTags?: string[];
  delimiterTagsMapping?: Record<string, string>;
  ignore?: string[];
  skipUnknownTags?: boolean;
  enforceListTags?: boolean;
  newline?: string;
}

export class RisParser {
  static readonly START_TAG = "TY";
  static readonly END_TAG = "ER";
  static readonly UNKNOWN_TAG = "UK";

  private readonly mapping: Record<string, string>;
  private readonly listTags: Set<string>;
  private readonly delimiterMap: Record<string, string>;
  private readonly ignore: Set<string>;
  private readonly skipUnknownTags: boolean;
  private readonly enforceListTags: boolean;
  private readonly newline: string;

  constructor(options: RisParserOptions = {}) {
    this.mapping = options.mapping ?? TAG_KEY_MAPPING;
    this.listTags = new Set(options.listTags ?? [...LIST_TYPE_TAGS]);
    this.delimiterMap = options.delimiterTagsMapping ?? DELIMITED_TAG_MAPPING;
    this.ignore = new Set(options.ignore ?? []);
    this.skipUnknownTags = options.skipUnknownTags ?? false;
    this.enforceListTags = options.enforceListTags ?? true;
    this.newline = options.newline ?? "\n";
  }

  parse(text: string): RisRecord[] {
    const lines = text.split(this.newline);
    return this.parseLines(lines);
  }

  parseLines(lines: string[]): RisRecord[] {
    const out: RisRecord[] = [];
    let record: RisRecord | null = null;
    let lastTag: string | null = null;

    for (const rawLine of lines) {
      const [tag, content] = this.parseLine(rawLine);
      if (tag === null) {
        if (record && lastTag) {
          this.addTag(record, lastTag, content, true);
        }
        continue;
      }

      if (tag === RisParser.START_TAG) {
        if (record) {
          out.push(record);
        }
        record = {};
        this.addTag(record, tag, content, false);
        lastTag = tag;
        continue;
      }

      if (!record || this.ignore.has(tag)) {
        continue;
      }

      if (tag === RisParser.END_TAG) {
        out.push(record);
        record = null;
        lastTag = null;
        continue;
      }

      this.addTag(record, tag, content, false);
      lastTag = tag;
    }

    if (record) {
      out.push(record);
    }
    return out;
  }

  parseLine(line: string): [string, string] | [null, string] {
    if (line.slice(2, 5) === "  -" && /^[A-Z]/.test(line.slice(0, 1)) && line.slice(0, 2).toUpperCase() === line.slice(0, 2)) {
      return [line.slice(0, 2), line.slice(6).trim()];
    }
    return [null, line.trim()];
  }

  private addSingleValue(record: RisRecord, name: string, value: string | string[], isMulti: boolean): void {
    const current = record[name];
    if (isMulti) {
      if (Array.isArray(current) && Array.isArray(value)) {
        record[name] = [...current, ...value];
      } else if (Array.isArray(current) && typeof value === "string") {
        record[name] = [...current, value];
      } else {
        const existing = typeof current === "string" ? current : "";
        if (Array.isArray(value)) {
          record[name] = [existing, ...value].filter(Boolean);
        } else {
          record[name] = `${existing} ${value}`.trim();
        }
      }
      return;
    }

    if (this.enforceListTags || current === undefined) {
      if (current === undefined) {
        record[name] = value;
      }
      return;
    }

    this.addListValue(record, name, value);
  }

  private addListValue(record: RisRecord, name: string, value: string | string[]): void {
    const valueList = Array.isArray(value) ? value : [value];
    const current = record[name];
    if (current === undefined) {
      record[name] = [...valueList];
      return;
    }
    if (Array.isArray(current)) {
      record[name] = [...current, ...valueList];
      return;
    }
    record[name] = [String(current), ...valueList];
  }

  private addTag(record: RisRecord, tag: string, content: string, extendMultiline: boolean): void {
    const name = this.mapping[tag];
    if (!name) {
      if (this.skipUnknownTags) {
        return;
      }
      const unknownName = this.mapping[RisParser.UNKNOWN_TAG] ?? "unknown_tag";
      const current = (record[unknownName] as UnknownTagMap | undefined) ?? {};
      const list = current[tag] ?? [];
      current[tag] = [...list, content];
      record[unknownName] = current;
      return;
    }

    let value: string | string[] = content;
    const delimiter = this.delimiterMap[tag];
    if (delimiter) {
      value = content.split(delimiter).map((part) => part.trim());
    }

    if (this.listTags.has(tag)) {
      this.addListValue(record, name, value);
      return;
    }

    this.addSingleValue(record, name, value, extendMultiline);
  }
}

export function loads(text: string, options: RisParserOptions = {}): RisRecord[] {
  return new RisParser(options).parse(text);
}
