import { format } from 'date-fns'

export const formatDate = (date: Date) => format(date, 'dd.MM.yyyy HH:mm:ss')

export const log = (...args: unknown[]) => console.log(formatDate(new Date()), '-', ...args)
