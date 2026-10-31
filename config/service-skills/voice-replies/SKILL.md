---
name: voice-replies
description: Load before calling send_voice_message, that is when the current message explicitly asks you to answer by voice or to send a voice message. It says how to write the spoken text, the delivery tags, the length and the caption.
---

# Voice replies

The voice message is spoken by the Eleven v4 model in a young woman's voice. The model takes intonation, emotion and pauses from the text itself, so write `text` the way you yourself would record a voice message to someone close, not read from a sheet: it is the same answer you would give in text, only as spoken language.

## Live speech

- Speak in the language of the answer in short phrases, as in a live conversation, and address the person. No Markdown, lists, tables, emoji, links or code.
- Write numbers, dates, amounts, times, units and abbreviations in words the way they are pronounced: "двадцать третьего сентября", "полторы тысячи рублей", "в половине восьмого". No digits.
- Punctuation controls the delivery. An ellipsis gives a pause and weight, a dash changes the intonation, question and exclamation marks liven up the melody of a phrase. Set a pause with an ellipsis, the structure of phrases or the `[pause]` tag; the model does not support SSML markup like `<break>`. You may write a key word in CAPITALS for logical stress, no more than two words per message.

## Delivery tags

Tags in square brackets set the emotion, manner and sounds of the voice. They are always in English and are never translated. Put a tag right before the phrase it colors, and a sound tag where the reaction sounds. Use one to three tags per message, only when they match the meaning and mood, and change them when the mood within the message changes; a calm businesslike answer can do without tags.

- Delivery and emotion: `[warmly]`, `[casual]`, `[cheerfully]`, `[excited]`, `[curious]`, `[thoughtful]`, `[softly]`, `[mischievously]`, `[whispers]`. The delivery can be described more precisely in a few words, for example `[quietly curious]` or `[gently reassuring]`: Eleven v4 usually follows such descriptions.
- Voice sounds: `[laughs]`, `[chuckles]`, `[sighs]`, `[exhales]`.
- Singing `[sings]` and an accent `[strong ... accent]` fit only on a direct request to sing or imitate an accent.

Do not write tags for actions and facial expressions like `[smiles]`, `[nods]` or `[walks away]`: the voice does not pronounce them. Do not use sound effects like `[applause]` or `[explosion]` or tags that contradict the meaning of what is said. Tags do not replace words: the meaning of the answer must be clear without them. If the topic is serious or painful, such as loss, illness or anxiety, speak calmly and gently, without playful tags or laughter.

## Length and caption

By default a voice message is short, up to about one and a half thousand characters; longer, up to five thousand, only when the person asks for a detailed story: every character spends ElevenLabs credits. Put links, addresses, code and other data that are awkward to listen to into `caption`. Do not write a note before the call saying that you are recording a voice message.

## After the call

A delivered voice message is your answer: follow the `nextStep` of the result and do not retell the voice message in text. If the call returned an error, do not call it again in this turn and answer the same request with ordinary text, starting as the error's `correction` says.

Example. The person asks "ответь голосом, сколько стоит билет". Bad `text`: "Билет стоит 1 500 ₽, подробнее: https://…" (digits, a sign and a link the voice will read out). Good `text`: "[casual] Билет стоит полторы тысячи рублей... ссылку на покупку я положила в подпись.", with the link in `caption`.
