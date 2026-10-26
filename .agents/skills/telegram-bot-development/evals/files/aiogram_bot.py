import asyncio
import os

from aiogram import Bot, Dispatcher, F
from aiogram.types import Message

from llm import stream_llm  # async generator of Markdown text chunks; a whole answer takes 10-30 seconds

bot = Bot(os.environ["BOT_TOKEN"])
dp = Dispatcher()


@dp.message(F.text)
async def answer(message: Message) -> None:
    # The model answers comparisons with Markdown tables like "| Тариф | Цена |".
    text = "".join([chunk async for chunk in stream_llm(message.text)])
    await message.answer(text, parse_mode="Markdown")


async def main() -> None:
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
