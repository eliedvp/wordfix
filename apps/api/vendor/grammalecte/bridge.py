# SPDX-License-Identifier: GPL-3.0-or-later
#
# Pont entre le worker WordFix (Node.js) et Grammalecte (GPL-3.0).
#
# Ce script est un programme distinct, sous licence GPL-3.0-or-later, lancé par
# le worker comme processus enfant. Les deux programmes communiquent uniquement
# par des messages JSON (une ligne par message) sur l'entrée et la sortie
# standard : aucun code de Grammalecte n'est chargé dans le processus Node.js.
#
# Usage : python3 -I bridge.py <archive grammalecte.zip> [options activées]
#   options activées : noms d'options Grammalecte séparés par des virgules
#   (par défaut, les options de grammaire ci-dessous) ; les autres sont désactivées.
#
# Protocole :
#   au démarrage, une ligne {"type": "ready", "version": ..., "loadMs": ...} ;
#   requête  : {"id": 1, "paragraphs": ["texte", ...]}
#   réponse  : {"id": 1, "results": [[erreur, ...] | null, ...]}
#              (null : le paragraphe n'a pas pu être analysé)
#   erreur   : {"id": 1, "error": "message"}
#
# Chaque erreur : {"start", "end", "ruleId", "type", "message", "suggestions"}.
# Les positions sont exprimées en unités UTF-16, comme les chaînes JavaScript
# (Python compte en points de code : la conversion est faite ici).
#
# Aucune donnée n'est écrite sur disque, aucun appel réseau n'est effectué, et
# le texte analysé n'est jamais journalisé.

import json
import sys
import time

# Options de Grammalecte activées par défaut : grammaire uniquement (accords, conjugaison,
# confusions, modes verbaux, locutions). Typographie, style et orthographe sont
# désactivés : WordFix les traite avec ses propres analyseurs.
DEFAULT_OPTIONS = frozenset(
    ["conf", "loc", "gn", "infi", "conj", "ppas", "imp", "inte", "vmode"]
)
MAX_SUGGESTIONS = 5
MAX_MESSAGE_LENGTH = 400
# Grammalecte mémorise l'analyse de chaque forme rencontrée : au-delà de ce
# nombre de formes, la mémoire est vidée (mémoire bornée sur un worker longue durée).
MAX_STORED_FORMS = 100000


def utf16_offsets(text):
    """Table point de code -> unité UTF-16 (None si le texte est entièrement BMP)."""
    if all(ord(char) <= 0xFFFF for char in text):
        return None
    table = [0] * (len(text) + 1)
    position = 0
    for index, char in enumerate(text):
        table[index] = position
        position += 2 if ord(char) > 0xFFFF else 1
    table[len(text)] = position
    return table


def check_paragraph(engine, text):
    table = utf16_offsets(text)
    out = []
    for error in engine.parse(text, "FR", bDebug=False, dOptions=None, bContext=False):
        start = error["nStart"]
        end = error["nEnd"]
        if not (0 <= start < end <= len(text)):
            continue
        out.append(
            {
                "start": table[start] if table else start,
                "end": table[end] if table else end,
                "ruleId": error.get("sRuleId", ""),
                "type": error.get("sType", ""),
                "message": str(error.get("sMessage", ""))[:MAX_MESSAGE_LENGTH],
                "suggestions": [str(s) for s in error.get("aSuggestions", [])][:MAX_SUGGESTIONS],
            }
        )
    return out


def bound_storage(engine):
    spell = engine.getSpellChecker()
    if len(getattr(spell, "_dMorphologies", {})) > MAX_STORED_FORMS:
        spell.clearStorage()


def write(message):
    # ensure_ascii : la sortie reste en ASCII pur, quel que soit l'encodage du système.
    sys.stdout.write(json.dumps(message, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) not in (2, 3):
        sys.stderr.write("usage: bridge.py <grammalecte.zip> [options]\n")
        return 2
    enabled = DEFAULT_OPTIONS
    if len(sys.argv) == 3:
        enabled = frozenset(name for name in sys.argv[2].split(",") if name)
    started = time.monotonic()
    sys.path.insert(0, sys.argv[1])
    import grammalecte.fr as engine  # noqa: E402 (chemin connu seulement ici)

    engine.load("Python")
    options = {name: name in enabled for name in engine.getOptions()}
    engine.setOptions(options)
    write(
        {
            "type": "ready",
            "version": getattr(engine, "version", "unknown"),
            "loadMs": round((time.monotonic() - started) * 1000),
        }
    )

    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            results = []
            for text in request.get("paragraphs", []):
                try:
                    results.append(check_paragraph(engine, str(text)))
                except Exception as error:  # un paragraphe en échec n'arrête pas les autres
                    sys.stderr.write("grammalecte: paragraphe ignoré (%s)\n" % type(error).__name__)
                    results.append(None)
            write({"id": request_id, "results": results})
            bound_storage(engine)
        except Exception as error:
            write({"id": request_id, "error": type(error).__name__})
    return 0


if __name__ == "__main__":
    sys.exit(main())
