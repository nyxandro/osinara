import { Bot } from 'grammy'

const bot = new Bot(process.env.BOT_TOKEN!)

const RULES = [
  '1. Без рекламы и ссылок на другие чаты.',
  '2. Вопросы по заказам — в личку менеджеру.',
  '3. Уважайте друг друга.',
].join('\n')

bot.on('message:new_chat_members', async (ctx) => {
  await ctx.reply('Добро пожаловать! Прочитайте правила чата.', {
    reply_markup: { inline_keyboard: [[{ text: 'Правила', callback_data: 'rules' }]] },
  })
})

// Everyone in the group sees the rules every time someone presses the button.
bot.callbackQuery('rules', async (ctx) => {
  await ctx.reply(RULES)
  await ctx.answerCallbackQuery()
})

bot.start()
