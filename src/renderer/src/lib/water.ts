import {
  WATER_GLASS_ML,
  WATER_GOAL_MAX,
  WATER_GOAL_MIN,
  WATER_REMINDER_MAX,
  type WaterState
} from '../../../shared/types'
import { clamp, pad, todayKey } from './time'

export const WATER_REMINDER_PRESETS = [0, 30, 60, 120, 180] as const

export function waterToday(water: WaterState, today = todayKey()): WaterState {
  if (water.dayKey === today) return water
  return { ...water, dayKey: today, pours: [] }
}

export function waterCount(water: WaterState, today = todayKey()): number {
  return waterToday(water, today).pours.length
}

export function waterFill(count: number, goal: number): number {
  if (goal <= 0) return 0
  return Math.max(0, Math.min(1, count / goal))
}

export function clampWaterGoal(glasses: number): number {
  return clamp(Math.round(glasses) || WATER_GOAL_MIN, WATER_GOAL_MIN, WATER_GOAL_MAX)
}

export function clampWaterReminder(minutes: number): number {
  const clean = Math.round(Number(minutes) || 0)
  if (clean <= 0) return 0
  return clamp(clean, 1, WATER_REMINDER_MAX)
}

export function formatWaterMl(glasses: number, glassMl = WATER_GLASS_ML): string {
  return `${(glasses * glassMl).toLocaleString()} ml`
}

export function formatWaterReminderShort(minutes: number): string {
  if (minutes <= 0) return 'Off'
  if (minutes % 60 === 0) return `${minutes / 60}h`
  if (minutes > 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return `${hours}h ${rest}m`
  }
  return `${minutes}m`
}

export function formatWaterReminderLong(minutes: number): string {
  if (minutes <= 0) return 'Off'
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }
  if (minutes > 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return `${hours}h ${rest}m`
  }
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

export function formatWaterCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`
  }
  return `${pad(minutes)}:${pad(seconds)}`
}
