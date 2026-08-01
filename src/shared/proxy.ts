import type { ProxyRunState } from '@core/domain/proxy'

/**
 * Предикаты над DTO прокси. Живут в shared, а не в core, потому что нужны
 * одновременно трею (main) и панели (renderer), а renderer видит только
 * IPC-контракт (ADR-0005). Тип состояния остаётся в core/domain — здесь только
 * чтение проекции, которая и так ходит по IPC.
 */

/** Прокси «включена» с точки зрения пользователя (тумблер в положении on). */
export const isProxyOn = (s: ProxyRunState): boolean => s !== 'off' && s !== 'error'
