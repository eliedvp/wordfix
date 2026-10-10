import { describe, expect, it } from 'vitest';
import { attrOf, childrenOf, decodeXmlEntities, findDeep, parseXml, textOf } from './xml.js';

function textIn(xml: string): string {
  const node = findDeep(parseXml(xml, 'test'), 'w:t');
  return node ? childrenOf(node).map(textOf).join('') : '';
}

describe('Décodage des entités XML', () => {
  it('décode les références numériques décimales et hexadécimales', () => {
    expect(textIn('<w:t>l&#8217;eau&#160;: 10&#xA0;% &#x1F600;</w:t>')).toBe(
      'l’eau\u00a0: 10\u00a0% 😀',
    );
  });

  it('décode les 5 entités standard, en une seule passe', () => {
    expect(textIn('<w:t>a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;</w:t>')).toBe(
      'a & b <c> "d" \'e\'',
    );
    // « &amp;#160; » est le texte littéral « &#160; », pas une espace insécable.
    expect(textIn('<w:t>&amp;#160; &amp;amp;</w:t>')).toBe('&#160; &amp;');
  });

  it('accepte les zéros en tête, en décimal comme en hexadécimal', () => {
    expect(textIn('<w:t>&#00000065;&#0000000000233;&#x0000041;&#x00000000E9;</w:t>')).toBe('AéAé');
    // Toujours une seule passe : la forme échappée reste du texte.
    expect(textIn('<w:t>&amp;#00000065; &amp;#x0000041;</w:t>')).toBe('&#00000065; &#x0000041;');
  });

  it('valeur hors de l’Unicode, même très longue : laissée telle quelle', () => {
    const huge = `&#${'9'.repeat(400)};`;
    expect(decodeXmlEntities(`${huge} &#x${'F'.repeat(40)}; &#x110000;`)).toBe(
      `${huge} &#x${'F'.repeat(40)}; &#x110000;`,
    );
  });

  it('laisse tels quels les références invalides et les noms inconnus', () => {
    expect(decodeXmlEntities('&#0; &#xD800; &#x110000; &nbsp; & seul')).toBe(
      '&#0; &#xD800; &#x110000; &nbsp; & seul',
    );
  });

  it('décode aussi les valeurs d’attributs', () => {
    const node = findDeep(parseXml('<w:x w:val="a&amp;b&#233;&quot;"/>', 'test'), 'w:x');
    expect(node && attrOf(node, 'w:val')).toBe('a&bé"');
  });

  it('refuse toujours les DTD et entités déclarées', () => {
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY e "boum">]><w:t>&e;</w:t>', 'test')).toThrow(
      /DTD/,
    );
  });
});
