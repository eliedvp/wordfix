import { attrOf, childByTag, childrenOf, findDeep, parseXml, tagOf } from './xml.js';

/** Informations utiles d'un style de paragraphe Word. */
export interface StyleInfo {
  id: string;
  name: string | null;
  basedOn: string | null;
  /** Niveau de plan (0 = niveau 1), s'il est défini directement sur le style. */
  outlineLevel: number | null;
}

export type StyleRole = 'heading' | 'title' | 'toc' | 'caption' | 'normal';

export interface ResolvedStyle {
  role: StyleRole;
  /** Niveau de titre (1 à 9) pour role = heading / title. */
  level: number | null;
  source: 'style' | 'outline' | null;
}

const HEADING_NAME = /^(?:heading|titre)\s*(\d)$/i;
const TITLE_NAME = /^(?:title|titre)$/i;
const TOC_NAME = /^(?:toc\s*\d|tm\s*\d|toc heading|en-tête de table des matières)$/i;
const CAPTION_NAME = /^(?:caption|légende)$/i;

export class StyleMap {
  private readonly styles = new Map<string, StyleInfo>();
  private readonly cache = new Map<string, ResolvedStyle>();

  static parse(stylesXml: string | null): StyleMap {
    const map = new StyleMap();
    if (!stylesXml) return map;
    const root = findDeep(parseXml(stylesXml, 'word/styles.xml'), 'w:styles');
    for (const node of root ? childrenOf(root) : []) {
      if (tagOf(node) !== 'w:style' || attrOf(node, 'w:type') !== 'paragraph') continue;
      const id = attrOf(node, 'w:styleId');
      if (!id) continue;
      const pPr = childByTag(node, 'w:pPr');
      const outline = pPr ? childByTag(pPr, 'w:outlineLvl') : undefined;
      const outlineValue = outline ? Number(attrOf(outline, 'w:val')) : NaN;
      const nameNode = childByTag(node, 'w:name');
      const basedOnNode = childByTag(node, 'w:basedOn');
      map.styles.set(id, {
        id,
        name: nameNode ? (attrOf(nameNode, 'w:val') ?? null) : null,
        basedOn: basedOnNode ? (attrOf(basedOnNode, 'w:val') ?? null) : null,
        outlineLevel: Number.isInteger(outlineValue) ? outlineValue : null,
      });
    }
    return map;
  }

  nameOf(styleId: string | null): string | null {
    return styleId ? (this.styles.get(styleId)?.name ?? null) : null;
  }

  /** Rôle d'un style, en suivant la chaîne d'héritage (basedOn). */
  resolve(styleId: string | null): ResolvedStyle {
    if (!styleId) return { role: 'normal', level: null, source: null };
    const cached = this.cache.get(styleId);
    if (cached) return cached;

    let resolved: ResolvedStyle = { role: 'normal', level: null, source: null };
    const seen = new Set<string>();
    let current: string | null = styleId;

    while (current && !seen.has(current)) {
      seen.add(current);
      const info: StyleInfo | undefined = this.styles.get(current);
      // Un identifiant sans définition reste interprétable par son nom usuel.
      const name: string = info?.name ?? current;

      const heading = HEADING_NAME.exec(name) ?? HEADING_NAME.exec(current);
      if (heading) {
        resolved = { role: 'heading', level: Number(heading[1]), source: 'style' };
        break;
      }
      if (TITLE_NAME.test(name)) {
        resolved = { role: 'title', level: 1, source: 'style' };
        break;
      }
      if (TOC_NAME.test(name) || /^TOC\d|^TM\d/i.test(current)) {
        resolved = { role: 'toc', level: null, source: null };
        break;
      }
      if (CAPTION_NAME.test(name)) {
        resolved = { role: 'caption', level: null, source: null };
        break;
      }
      if (
        info?.outlineLevel !== null &&
        info?.outlineLevel !== undefined &&
        info.outlineLevel < 9
      ) {
        resolved = { role: 'heading', level: info.outlineLevel + 1, source: 'outline' };
        break;
      }
      current = info?.basedOn ?? null;
    }

    this.cache.set(styleId, resolved);
    return resolved;
  }
}
