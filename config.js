// Настройки, которые меняются редко. Всё остальное (курсы, реквизиты, токены) — в админке мини-аппа.
export const CONFIG = {
  NAME: "STRELA STARS",
  // владельцы админки: юзернеймы без @ или Telegram ID
  OWNERS: ["Sdelka_ton", "8526756128", "5982037496", "ane4kaloveMe", "trombolonkolyvocho"],
  SUPPORT: "@Sdelka_ton",
  // адрес TON-кошелька, с которого бот покупает звёзды на Fragment (тот же, что привязан к Fragment).
  // Сид-фразу сюда НЕ писать — только секретом WALLET_MNEMONIC в Cloudflare.
  WALLET_ADDRESS: "",
};
