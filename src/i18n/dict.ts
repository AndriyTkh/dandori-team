import type { Lang } from '../state/ui'

/*
 * Every string the interface shows, both languages side by side.
 *
 * One table, not two files: two files drift, and the first thing to go missing
 * is the translation nobody reads. Here a key with one language missing does
 * not compile.
 *
 * `{n}` and `{name}` are filled in by `translate`. Russian keeps its guillemets
 * and English its curly quotes — the punctuation is part of the language.
 */

export type Text = Record<Lang, string>

/**
 * The forms `Intl.PluralRules` picks between. Russian uses three of them and
 * English two, so every form but `other` is optional — `other` is the one CLDR
 * guarantees every language has, and it is what a missing form falls back to.
 */
export type Forms = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>
export type Plural = Record<Lang, Forms>

export const TEXT = {
  // -------------------------------------------------------------- common

  'common.untitled': { ru: 'Без названия', en: 'Untitled' },
  'common.cancel': { ru: 'Отмена', en: 'Cancel' },
  'common.done': { ru: 'Готово', en: 'Done' },
  'common.add': { ru: 'Добавить', en: 'Add' },

  // The pair on a markdown box: the same two words on the task card and in the
  // notes editor.
  'md.edit': { ru: 'Править', en: 'Edit' },
  'md.preview': { ru: 'Просмотр', en: 'Preview' },

  // ---------------------------------------------------------------- tabs

  'tab.board': { ru: 'Доска', en: 'Board' },
  'tab.timeline': { ru: 'Таймлайн', en: 'Timeline' },
  'tab.notes': { ru: 'Заметки', en: 'Notes' },

  // -------------------------------------------------------------- header

  'header.newWorkspace': { ru: 'Новый воркспейс', en: 'New workspace' },
  'header.workspaceName': { ru: 'Название воркспейса', en: 'Workspace name' },

  // ---------------------------------------------------------------- sync

  'sync.idle': { ru: 'Всё сохранено', en: 'Everything saved' },
  'sync.syncing': { ru: 'Синхронизация…', en: 'Syncing…' },
  'sync.offline': {
    ru: 'Офлайн, изменения сохранятся локально',
    en: 'Offline, changes are kept on this device',
  },
  'sync.error': { ru: 'Не удалось синхронизироваться', en: 'Could not sync' },

  // ------------------------------------------------------------- sign in

  'signin.password': { ru: 'Пароль', en: 'Password' },
  'signin.submit': { ru: 'Войти', en: 'Sign in' },
  'signin.busy': { ru: 'Вход…', en: 'Signing in…' },
  'signin.failed': { ru: 'Не удалось войти', en: 'Could not sign in' },

  // ----------------------------------------------------------- reminders

  'reminder.today': { ru: 'сегодня', en: 'today' },
  'reminder.dismiss': {
    ru: 'Скрыть до следующего входа',
    en: 'Hide until the app is opened again',
  },

  // --------------------------------------------------------------- board

  'board.mode.days': { ru: '14 дней', en: '14 days' },
  'board.mode.ribbon': { ru: 'Лента', en: 'Feed' },
  'board.mode.month': { ru: 'Месяц', en: 'Month' },

  'board.today': { ru: 'Сегодня', en: 'Today' },
  'board.tomorrow': { ru: 'Завтра', en: 'Tomorrow' },
  'board.yesterday': { ru: 'Вчера', en: 'Yesterday' },
  'board.noDate': { ru: 'Без даты', en: 'No date' },
  'board.newTask': { ru: 'Новая задача', en: 'New task' },
  'board.taskPlaceholder': { ru: 'Задача', en: 'Task' },
  'board.prevMonth': { ru: 'Предыдущий месяц', en: 'Previous month' },
  'board.nextMonth': { ru: 'Следующий месяц', en: 'Next month' },

  // ------------------------------------------------------------ timeline

  'timeline.zoom.all': { ru: 'Всё', en: 'All' },
  'timeline.zoom.month': { ru: 'Месяц', en: 'Month' },

  // ----------------------------------------------------------- task card

  'task.title': { ru: 'Название', en: 'Title' },
  'task.start': { ru: 'Начало', en: 'Start' },
  'task.due': { ru: 'Дедлайн', en: 'Deadline' },
  'task.remind': { ru: 'Напомнить', en: 'Remind' },
  'task.remindNever': { ru: 'Не напоминать', en: 'No reminder' },
  'task.mute': { ru: 'Не показывать в напоминаниях', en: 'Keep out of reminders' },
  'task.description': { ru: 'Описание', en: 'Description' },
  'task.delete': { ru: 'Удалить задачу', en: 'Delete task' },
  'task.confirmDelete': { ru: 'Удалить задачу «{name}»?', en: 'Delete the task “{name}”?' },

  'task.note': { ru: 'Заметка', en: 'Note' },
  'task.noteUnlink': { ru: 'Отвязать', en: 'Unlink' },
  'task.noteOpen': { ru: 'Открыть', en: 'Open' },
  'task.notePick': { ru: 'Выбрать заметку', en: 'Choose a note' },
  'task.noteCreate': { ru: 'Создать', en: 'Create' },
  'task.noteAttach': { ru: 'Привязать заметку', en: 'Attach a note' },

  'task.fields': { ru: 'Поля', en: 'Fields' },
  'task.fieldName': { ru: 'Имя поля', en: 'Field name' },
  'task.fieldValue': { ru: 'Значение', en: 'Value' },
  'task.fieldDelete': { ru: 'Удалить поле', en: 'Delete field' },

  // -------------------------------------------------------------- labels

  'label.plural': { ru: 'Метки', en: 'Labels' },
  'label.default': { ru: 'Метка', en: 'Label' },
  'label.manage': { ru: 'Правка', en: 'Edit' },
  'label.new': { ru: 'Новая', en: 'New' },
  'label.name': { ru: 'Название метки', en: 'Label name' },
  'label.delete': { ru: 'Удалить метку', en: 'Delete label' },
  'label.confirmDelete': {
    ru: 'Удалить метку «{name}»? Она снимется со всех задач.',
    en: 'Delete the label “{name}”? It comes off every task.',
  },

  // --------------------------------------------------------------- notes

  'notes.newFile': { ru: 'Новая заметка', en: 'New note' },
  'notes.newFolder': { ru: 'Новая папка', en: 'New folder' },
  'notes.actions': { ru: 'Действия', en: 'Actions' },
  'notes.rename': { ru: 'Переименовать', en: 'Rename' },
  'notes.delete': { ru: 'Удалить', en: 'Delete' },
  'notes.confirmDeleteFolder': {
    ru: 'Удалить папку «{name}» со всем содержимым?',
    en: 'Delete the folder “{name}” and everything in it?',
  },
  'notes.confirmDeleteFile': {
    ru: 'Удалить заметку «{name}»?',
    en: 'Delete the note “{name}”?',
  },
  'notes.back': { ru: 'К дереву', en: 'Back to the tree' },
  'notes.name': { ru: 'Название', en: 'Title' },

  // ------------------------------------------------------------ settings

  'settings.title': { ru: 'Настройки', en: 'Settings' },
  'settings.theme': { ru: 'Тема', en: 'Theme' },
  'settings.language': { ru: 'Язык', en: 'Language' },
  'settings.workspace': { ru: 'Воркспейс', en: 'Workspace' },
  'settings.account': { ru: 'Аккаунт', en: 'Account' },

  'settings.themeSystem': { ru: 'Как в системе', en: 'Match the system' },
  'settings.themeLight': { ru: 'Светлая', en: 'Light' },
  'settings.themeDark': { ru: 'Тёмная', en: 'Dark' },

  'settings.rename': { ru: 'Переименовать воркспейс', en: 'Rename workspace' },
  'settings.remove': { ru: 'Удалить воркспейс', en: 'Delete workspace' },
  'settings.confirmRemove': {
    ru: 'Удалить воркспейс «{name}»? Вместе с ним удалятся его задачи, метки и заметки.',
    en: 'Delete the workspace “{name}”? Its tasks, labels and notes go with it.',
  },

  'settings.export': { ru: 'Экспорт в JSON', en: 'Export to JSON' },
  'settings.signOut': { ru: 'Выйти', en: 'Sign out' },
} as const satisfies Record<string, Text>

export type TextKey = keyof typeof TEXT

/*
 * Counted phrases, whole. Not a number glued to a noun: «просрочено на 3 дня»
 * puts the count in the middle and "3 days overdue" puts it at the front, so
 * the word order belongs to the entry and not to the code.
 */
export const PLURALS = {
  'reminder.overdue': {
    ru: {
      one: 'просрочено на {n} день',
      few: 'просрочено на {n} дня',
      many: 'просрочено на {n} дней',
      other: 'просрочено на {n} дней',
    },
    en: { one: '{n} day overdue', other: '{n} days overdue' },
  },
  'reminder.soon': {
    ru: {
      one: 'через {n} день',
      few: 'через {n} дня',
      many: 'через {n} дней',
      other: 'через {n} дней',
    },
    en: { one: 'in {n} day', other: 'in {n} days' },
  },
  'task.remindBefore': {
    ru: {
      one: 'За {n} день',
      few: 'За {n} дня',
      many: 'За {n} дней',
      other: 'За {n} дней',
    },
    en: { one: '{n} day before', other: '{n} days before' },
  },
} as const satisfies Record<string, Plural>

export type PluralKey = keyof typeof PLURALS
