import express from 'express'
import { Bot } from 'grammy'

const token = process.env.BOT_TOKEN!
const bot = new Bot(token)
const app = express()
app.use(express.json())

// Members joining the group get a welcome with a button
bot.on('chat_member', async (ctx) => {
  if (ctx.chatMember.new_chat_member.status === 'member') {
    await ctx.reply(`Welcome, ${ctx.chatMember.new_chat_member.user.first_name}!`, {
      reply_markup: { inline_keyboard: [[{ text: 'Get bonus', callback_data: 'bonus' }]] },
    })
  }
})

bot.callbackQuery('bonus', async (ctx) => {
  await grantBonus(ctx.from.id) // adds 100 points to the user's balance
  await ctx.reply('Bonus added!')
})

bot.on('message:text', async (ctx) => {
  const answer = await askLlm(ctx.message.text) // takes 10-40 seconds
  await ctx.reply(answer, { parse_mode: 'MarkdownV2' })
})

app.post('/telegram/webhook', async (req, res) => {
  console.log('update from telegram', JSON.stringify(req.body), 'token', token)
  await bot.handleUpdate(req.body)
  res.sendStatus(200)
})

app.listen(8443, async () => {
  await bot.init()
  await bot.api.setWebhook('https://bot.example.com/telegram/webhook')
})

declare function grantBonus(userId: number): Promise<void>
declare function askLlm(text: string): Promise<string>
