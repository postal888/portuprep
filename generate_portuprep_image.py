#!/usr/bin/env python3
"""
Генерация недорогой картинки для карточек PortuPrep (запоминание слова / контекст).

Запуск — macOS/Linux:
  export OPENAI_API_KEY="sk-..."
  export PROMPT="минималистичная иллюстрация: португальское слово falar, речь, тёплые тона"
  pip install openai
  python3 generate_portuprep_image.py

Запуск — Windows PowerShell:
  $env:OPENAI_API_KEY="sk-..."
  $env:PROMPT="минималистичная иллюстрация для карточки слова: comer, еда, простой стиль"
  pip install openai
  python generate_portuprep_image.py
"""

from __future__ import annotations

import base64
import os
import sys

from openai import OpenAI
from openai import APIError, APIConnectionError, RateLimitError, AuthenticationError


def main() -> None:
    try:
        key = os.environ["OPENAI_API_KEY"].strip()
    except KeyError:
        print(
            "Ошибка: переменная окружения OPENAI_API_KEY не задана.\n"
            "Задайте ключ (см. комментарий в начале файла).",
            file=sys.stderr,
        )
        sys.exit(1)
    if not key:
        print("Ошибка: OPENAI_API_KEY пустой.", file=sys.stderr)
        sys.exit(1)

    try:
        prompt = os.environ["PROMPT"].strip()
    except KeyError:
        print(
            "Ошибка: переменная окружения PROMPT не задана.\n"
            "Пример (Linux/macOS): export PROMPT=\"минималистичная иллюстрация: слово falar, диалог\"\n"
            "Пример (PowerShell): $env:PROMPT=\"простая картинка для карточки: comer, еда\"",
            file=sys.stderr,
        )
        sys.exit(1)
    if not prompt:
        print("Ошибка: PROMPT пустой.", file=sys.stderr)
        sys.exit(1)

    try:
        client = OpenAI()
        response = client.images.generate(
            model="gpt-image-1-mini",
            prompt=prompt,
            size="1024x1024",
            quality="low",
            output_format="png",
        )
    except AuthenticationError as e:
        print(f"Ошибка авторизации OpenAI: {e}", file=sys.stderr)
        sys.exit(1)
    except RateLimitError as e:
        print(f"Лимит запросов: {e}", file=sys.stderr)
        sys.exit(1)
    except APIConnectionError as e:
        print(f"Нет соединения с API: {e}", file=sys.stderr)
        sys.exit(1)
    except APIError as e:
        print(f"Ошибка API OpenAI: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Неожиданная ошибка: {e}", file=sys.stderr)
        sys.exit(1)

    if not response.data:
        print("Пустой ответ: нет response.data.", file=sys.stderr)
        sys.exit(1)

    item = response.data[0]
    b64 = getattr(item, "b64_json", None)
    if not b64:
        print(
            "В ответе нет b64_json. Проверьте модель и параметры генерации.",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        raw = base64.b64decode(b64)
    except Exception as e:
        print(f"Не удалось декодировать b64_json: {e}", file=sys.stderr)
        sys.exit(1)

    out = "output.png"
    try:
        with open(out, "wb") as f:
            f.write(raw)
    except OSError as e:
        print(f"Не удалось записать {out}: {e}", file=sys.stderr)
        sys.exit(1)

    print("Saved to output.png")


if __name__ == "__main__":
    main()
