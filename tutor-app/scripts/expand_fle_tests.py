# -*- coding: utf-8 -*-
"""
Append grammar/conjugation FLE tests aligned with fle-course-program (book units).

O PDF do livro neste ambiente não tem camada de texto (só imagem); o conteúdo segue
a mesma progressão que `public/course/fle-course-program.json`.

Histórico: o primeiro grande lote (~128 itens) já foi fundido no repositório; este
ficheiro mantém apenas o «segundo lote» para reexecução segura (`python scripts/expand_fle_tests.py`).
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JSON_PATH = ROOT / "public" / "course" / "fle-tests.json"


def load_next_ids(tests: list) -> dict[int, int]:
    mx: dict[int, int] = defaultdict(int)
    for t in tests:
        m = re.match(r"^u(\d+)_t(\d+)$", str(t.get("id", "")))
        if m:
            u, n = int(m.group(1)), int(m.group(2))
            mx[u] = max(mx[u], n)
    return mx


def nid(mx: dict[int, int], unit: int) -> str:
    mx[unit] += 1
    return f"u{unit:02d}_t{mx[unit]:02d}"


def mc_options(correct: str, distractors: list[str]) -> list[str]:
    opts = [correct] + [d for d in distractors if d and fle_norm(d) != fle_norm(correct)]
    seen = set()
    out = []
    for o in opts:
        k = fle_norm(o)
        if k in seen:
            continue
        seen.add(k)
        out.append(o)
    while len(out) < 4:
        out.append(correct + "x")
    return out[:4]


def fle_norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def conj(
    mx,
    unit: int,
    verb: str,
    person: str,
    tense: str,
    answer: str,
    grammar_topic: str,
    explanation: str,
    explanation_ru: str,
    difficulty: int = 2,
):
    return {
        "id": nid(mx, unit),
        "unitId": unit,
        "testType": "conjugation",
        "difficulty": difficulty,
        "grammarTopic": grammar_topic,
        "verb": verb,
        "person": person,
        "tense": tense,
        "correctAnswer": answer,
        "explanation": explanation,
        "explanationRu": explanation_ru,
    }


def mc(
    mx,
    unit: int,
    question: str,
    correct: str,
    distractors: list[str],
    grammar_topic: str,
    explanation: str,
    explanation_ru: str,
    difficulty: int = 2,
):
    return {
        "id": nid(mx, unit),
        "unitId": unit,
        "testType": "multiple_choice",
        "difficulty": difficulty,
        "grammarTopic": grammar_topic,
        "question": question,
        "options": mc_options(correct, distractors),
        "correctAnswer": correct,
        "explanation": explanation,
        "explanationRu": explanation_ru,
    }


def fb(
    mx,
    unit: int,
    question: str,
    answer: str,
    accepted: list[str] | None,
    grammar_topic: str,
    explanation: str,
    explanation_ru: str,
    difficulty: int = 2,
):
    acc = [answer] if not accepted else accepted
    return {
        "id": nid(mx, unit),
        "unitId": unit,
        "testType": "fill_blank",
        "difficulty": difficulty,
        "grammarTopic": grammar_topic,
        "question": question,
        "acceptedAnswers": acc,
        "correctAnswer": answer,
        "explanation": explanation,
        "explanationRu": explanation_ru,
    }


def main():
    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    tests: list = data["tests"]
    mx = load_next_ids(tests)
    new: list = []

    def add_conj_table(
        unit: int,
        verb: str,
        tense_label: str,
        forms: dict[str, str],
        topic_prefix: str,
        expl_pt: str,
        expl_ru: str,
        diff: int = 2,
    ):
        for person, ans in forms.items():
            new.append(
                conj(
                    mx,
                    unit,
                    verb,
                    person,
                    tense_label,
                    ans,
                    f"{topic_prefix} — {verb}",
                    f"{verb.upper()}, {person}: {ans}. {expl_pt}",
                    f"{verb}, лицо {person}: {ans}. {expl_ru}",
                    diff,
                )
            )

    # —— Segundo lote: mais presente / perfeito / futuro / gramática ——
    add_conj_table(
        2,
        "estudar",
        "presente do indicativo",
        {"eu": "estudo", "você": "estuda", "nós": "estudamos", "eles": "estudam"},
        "verbo ESTUDAR presente",
        "Regular -AR.",
        "Правильный -AR.",
        1,
    )
    add_conj_table(
        3,
        "escrever",
        "presente do indicativo",
        {"eu": "escrevo", "ele": "escreve", "nós": "escrevemos", "elas": "escrevem"},
        "verbo ESCREVER presente",
        "ESCREVER: escrevo na 1ª pessoa.",
        "ESCREVER: escrevo в 1-м лице.",
        2,
    )
    add_conj_table(
        3,
        "pedir",
        "presente do indicativo",
        {"eu": "peço", "você": "pede", "nós": "pedimos", "eles": "pedem"},
        "verbo PEDIR presente",
        "PEDIR: peço (alternância e→i).",
        "PEDIR: peço.",
        2,
    )
    add_conj_table(
        3,
        "ouvir",
        "presente do indicativo",
        {"eu": "ouço", "ela": "ouve", "nós": "ouvimos", "vocês": "ouvem"},
        "verbo OUVIR presente",
        "OUVIR: ouço.",
        "OUVIR: ouço.",
        2,
    )
    new.append(
        mc(
            mx,
            5,
            "Paulo é ___ alto ___ o irmão.",
            "mais... do que",
            ["tão... quanto", "menos... como", "muito... do que"],
            "comparativo de superioridade",
            "mais + adjetivo + do que.",
            "mais + прилагательное + do que.",
            2,
        )
    )
    new.append(
        mc(
            mx,
            6,
            "Fui ao médico ___ causa da dor. (motivo)",
            "por",
            ["para", "com", "de"],
            "preposições — por vs para",
            "por causa de = por motivo.",
            "por causa de — причина.",
            2,
        )
    )
    add_conj_table(
        7,
        "ler",
        "futuro do presente",
        {"eu": "lerei", "você": "lerá", "nós": "leremos", "eles": "lerão"},
        "futuro do presente — LER",
        "LER regular no futuro.",
        "LER в будущем.",
        2,
    )
    add_conj_table(
        8,
        "poder",
        "futuro do pretérito",
        {"eu": "poderia", "ele": "poderia", "nós": "poderíamos", "elas": "poderiam"},
        "futuro do pretérito — PODER",
        "PODER + -ia.",
        "PODER + -ia (условное).",
        2,
    )
    new.append(
        mc(
            mx,
            9,
            "O filme ___ foi ótimo. (discurso indireto: presente → imperfeito)",
            "era",
            ["é", "será", "foi"],
            "discurso indireto — concordância de tempos",
            "Presente no discurso direto → imperfeito no indireto.",
            "Настоящее в прямой речи → имперфект в косвенной.",
            3,
        )
    )
    add_conj_table(
        10,
        "partir",
        "presente do subjuntivo",
        {"eu": "parta", "você": "parta", "nós": "partamos", "eles": "partam"},
        "presente do subjuntivo — -IR",
        "Base -a para -IR.",
        "Основа -a для -IR.",
        2,
    )
    add_conj_table(
        11,
        "falar",
        "imperfeito do subjuntivo",
        {"eu": "falasse", "ele": "falasse", "nós": "falássemos", "vocês": "falassem"},
        "imperfeito do subjuntivo — -AR",
        "falaram → falasse.",
        "falaram → falasse.",
        2,
    )
    add_conj_table(
        13,
        "dizer",
        "futuro do subjuntivo",
        {"eu": "disser", "você": "disser", "nós": "dissermos", "eles": "disserem"},
        "futuro do subjuntivo — DIZER",
        "disser, dissermos, disserem.",
        "disser, dissermos, disserem.",
        3,
    )
    add_conj_table(
        14,
        "ver",
        "pretérito perfeito",
        {"eu": "vi", "ela": "viu", "nós": "vimos", "eles": "viram"},
        "pretérito perfeito — VER",
        "VER no pretérito.",
        "VER в перфекте.",
        2,
    )
    add_conj_table(
        16,
        "sair",
        "presente do subjuntivo",
        {"eu": "saia", "você": "saia", "nós": "saiamos", "elas": "saiam"},
        "presente do subjuntivo — SAIR",
        "SAIR: saia, saiamos, saiam (presente do subjuntivo).",
        "SAIR: saia, saiamos, saiam.",
        3,
    )
    new.append(
        fb(
            mx,
            17,
            "Diga-___ a verdade! (me — ênclise no imperativo)",
            "me",
            None,
            "ênclise — imperativo afirmativo",
            "Diga-me.",
            "Энклиза: Diga-me.",
            3,
        )
    )
    add_conj_table(
        18,
        "caber",
        "presente do indicativo",
        {"eu": "caibo", "você": "cabe", "nós": "cabemos", "eles": "cabem"},
        "revisão — CABER presente",
        "Caber: caibo (irregular).",
        "Caber: caibo.",
        3,
    )
    add_conj_table(
        18,
        "rir",
        "pretérito perfeito",
        {"eu": "ri", "ele": "riu", "nós": "rimos", "elas": "riram"},
        "revisão — RIR pretérito",
        "RIR no pretérito.",
        "RIR в перфекте.",
        2,
    )

    # dedupe by id (safety)
    existing_ids = {t["id"] for t in tests}
    for t in new:
        if t["id"] in existing_ids:
            raise SystemExit(f"duplicate id {t['id']}")
        existing_ids.add(t["id"])

    tests.extend(new)
    data["meta"]["totalTests"] = len(tests)

    JSON_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Added", len(new), "tests. Total:", len(tests))


if __name__ == "__main__":
    main()
