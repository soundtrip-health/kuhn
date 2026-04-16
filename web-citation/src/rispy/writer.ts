import { DELIMITED_TAG_MAPPING, LIST_TYPE_TAGS, TAG_KEY_MAPPING, type RisRecord } from "./config.js";

export interface RisWriterOptions {
  mapping?: Record<string, string>;
  listTags?: string[];
  delimiterTagsMapping?: Record<string, string>;
  ignore?: string[];
  skipUnknownTags?: boolean;
  enforceListTags?: boolean;
}

function invertMapping(mapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tag, key] of Object.entries(mapping)) {
    out[key.toLowerCase()] = tag;
  }
  return out;
}

export class RisWriter {
  static readonly START_TAG = "TY";
  static readonly END_TAG = "ER";
  static readonly UNKNOWN_TAG = "UK";
  static readonly DEFAULT_REFERENCE_TYPE = "JOUR";

  private readonly mapping: Record<string, string>;
  private readonly reverseMapping: Record<string, string>;
  private readonly listTags: Set<string>;
  private readonly delimiterMap: Record<string, string>;
  private readonly ignore: Set<string>;
  private readonly skipUnknownTags: boolean;
  private readonly enforceListTags: boolean;

  constructor(options: RisWriterOptions = {}) {
    this.mapping = options.mapping ?? TAG_KEY_MAPPING;
    this.reverseMapping = invertMapping(this.mapping);
    this.listTags = new Set(options.listTags ?? [...LIST_TYPE_TAGS]);
    this.delimiterMap = options.delimiterTagsMapping ?? DELIMITED_TAG_MAPPING;
    this.ignore = new Set(options.ignore ?? []);
    this.skipUnknownTags = options.skipUnknownTags ?? false;
    this.enforceListTags = options.enforceListTags ?? true;
  }

  formats(references: RisRecord[]): string {
    const lines: string[] = [];
    references.forEach((reference, index) => {
      lines.push(`${index + 1}.`);
      lines.push(this.formatLine(RisWriter.START_TAG, this.getReferenceType(reference)));

      const tagsToSkip = new Set([RisWriter.START_TAG, ...this.ignore]);
      if (this.skipUnknownTags) {
        tagsToSkip.add(RisWriter.UNKNOWN_TAG);
      }

      for (const [label, value] of Object.entries(reference)) {
        const tag = this.reverseMapping[label.toLowerCase()];
        if (!tag || tagsToSkip.has(tag) || value === undefined || value === null) {
          continue;
        }

        if (tag === RisWriter.UNKNOWN_TAG && typeof value === "object" && !Array.isArray(value)) {
          for (const [unknownTag, unknownValues] of Object.entries(value as Record<string, unknown>)) {
            const list = Array.isArray(unknownValues) ? unknownValues : [unknownValues];
            for (const entry of list) {
              lines.push(this.formatLine(unknownTag, String(entry)));
            }
          }
          continue;
        }

        if (this.listTags.has(tag) || (!this.enforceListTags && Array.isArray(value))) {
          const entries = Array.isArray(value) ? value : [value];
          for (const entry of entries) {
            lines.push(this.formatLine(tag, String(entry)));
          }
          continue;
        }

        if (this.delimiterMap[tag] && Array.isArray(value)) {
          lines.push(this.formatLine(tag, value.map(String).join(this.delimiterMap[tag])));
          continue;
        }

        lines.push(this.formatLine(tag, String(value)));
      }

      lines.push(this.formatLine(RisWriter.END_TAG));
    });

    return `${lines.join("\n")}\n`;
  }

  private getReferenceType(reference: RisRecord): string {
    const value = reference.type_of_reference;
    return typeof value === "string" && value.trim() ? value : RisWriter.DEFAULT_REFERENCE_TYPE;
  }

  private formatLine(tag: string, value = ""): string {
    return `${tag}  - ${value}`;
  }
}

export function dumps(references: RisRecord[], options: RisWriterOptions = {}): string {
  return new RisWriter(options).formats(references);
}
