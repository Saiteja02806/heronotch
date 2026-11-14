import {
  WATER_GLASS_ML,
  WATER_GOAL_MAX,
  WATER_GOAL_MIN,
  type WaterState
} from '../../../shared/types'
import { clamp, todayKey } from './time'

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

export function formatWaterMl(glasses: number, glassMl = WATER_GLASS_ML): string {
  return `${(glasses * glassMl).toLocaleString()} ml`
}
