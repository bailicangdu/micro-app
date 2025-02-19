import type { SandBoxInterface, microWindowType } from '@micro-app/types'
import bindFunction from './bind_function'
import {
  unique,
  setCurrentAppName,
  defer,
  getEffectivePath,
  rawWindow,
  rawDocument,
} from '../libs/utils'
import effect, { effectDocumentEvent, releaseEffectDocumentEvent } from './effect'
import { EventCenterForMicroApp } from '../interact'
import microApp from '../micro_app'

/* eslint-disable camelcase */
type injectDataType = {
  __MICRO_APP_ENVIRONMENT__: boolean
  __MICRO_APP_NAME__: string
  __MICRO_APP_PUBLIC_PATH__: string
  __MICRO_APP_BASE_URL__: string
  microApp: EventCenterForMicroApp
  rawWindow: Window
  rawDocument: Document
}

// 可以逃逸到外层window的变量
const staticEscapeProperties: PropertyKey[] = [
  'System',
  '__cjsWrapper',
  '__REACT_ERROR_OVERLAY_GLOBAL_HOOK__',
]

// 一些只能赋值到原window上的变量
const escapeSetterKeyList: PropertyKey[] = [
  'location',
]

const unscopables = {
  undefined: true,
  Array: true,
  Object: true,
  String: true,
  Boolean: true,
  Math: true,
  Number: true,
  Symbol: true,
  parseFloat: true,
  Float32Array: true,
}

/**
 * 宏任务延迟执行，解决vue3的部分渲染问题
 */
let macroTimer: number
function macroTask (fn: TimerHandler): void {
  if (macroTimer) clearTimeout(macroTimer)
  macroTimer = setTimeout(fn, 0)
}

export default class SandBox implements SandBoxInterface {
  static activeCount = 0 // 正在运行的沙盒数量
  active = false // 当前沙盒运行状态
  proxyWindow: WindowProxy & injectDataType
  releaseEffect: CallableFunction
  // 强隔离的全局变量(只能在沙箱中获取和设置的属性，不会兜底到外层window)
  scopeProperties: PropertyKey[] = ['webpackJsonp']
  // 可以泄漏到外部window的全局变量
  escapeProperties: PropertyKey[] = []
  microWindow = {} as Window & injectDataType // 代理原型
  injectedKeys: Set<PropertyKey> = new Set() // proxyWindow新添加的属性
  escapeKeys: Set<PropertyKey> = new Set() // 泄漏到外部window的变量，卸载时清除

  constructor (appName: string, url: string, macro: boolean) {
    const descriptorTargetMap = new Map<PropertyKey, 'target' | 'rawWindow'>()
    const hasOwnProperty = (key: PropertyKey) => this.microWindow.hasOwnProperty(key) || rawWindow.hasOwnProperty(key)
    // 通过插件系统获取隔离属性和可逃逸属性
    this.getScopeProperties(appName)
    // 注入全局变量
    this.inject(this.microWindow, appName, url)
    // 重写全局事件监听&定时器
    this.releaseEffect = effect(this.microWindow)

    this.proxyWindow = new Proxy(this.microWindow, {
      get: (target: microWindowType, key: PropertyKey): unknown => {
        if (key === Symbol.unscopables) return unscopables

        if (['window', 'self', 'globalThis'].includes(key as string)) {
          return this.proxyWindow
        }

        if (key === 'top' || key === 'parent') {
          if (rawWindow === rawWindow.parent) { // 不在iframe
            return this.proxyWindow
          }
          return Reflect.get(rawWindow, key) // iframe
        }

        if (key === 'hasOwnProperty') return hasOwnProperty

        if (key === 'document' || key === 'eval') {
          setCurrentAppName(appName)
          ;(macro ? macroTask : defer)(() => setCurrentAppName(null))
          switch (key) {
            case 'document':
              return rawDocument
            case 'eval':
              return eval
          }
        }

        if (this.scopeProperties.includes(key)) {
          return Reflect.get(target, key)
        }

        if (Reflect.has(target, key)) {
          return Reflect.get(target, key)
        }

        const rawValue = Reflect.get(rawWindow, key)

        return bindFunction(rawWindow, rawValue)
      },
      set: (target: microWindowType, key: PropertyKey, value: unknown): boolean => {
        if (this.active) {
          if (escapeSetterKeyList.includes(key)) {
            Reflect.set(rawWindow, key, value)
          } else if (
            !target.hasOwnProperty(key) &&
            rawWindow.hasOwnProperty(key) &&
            !this.scopeProperties.includes(key)
          ) {
            const descriptor = Object.getOwnPropertyDescriptor(rawWindow, key)
            const { writable, configurable, enumerable } = descriptor!
            if (writable) {
              Object.defineProperty(target, key, {
                configurable,
                enumerable,
                writable,
                value,
              })
              this.injectedKeys.add(key)
            }
          } else {
            Reflect.set(target, key, value)
            this.injectedKeys.add(key)
          }

          if (
            (
              this.escapeProperties.includes(key) ||
              (staticEscapeProperties.includes(key) && !Reflect.has(rawWindow, key))
            ) &&
            !this.scopeProperties.includes(key)
          ) {
            Reflect.set(rawWindow, key, value)
            this.escapeKeys.add(key)
          }
        }

        return true
      },
      has: (target: microWindowType, key: PropertyKey): boolean => {
        if (this.scopeProperties.includes(key)) return key in target
        return key in unscopables || key in target || key in rawWindow
      },
      getOwnPropertyDescriptor: (target: microWindowType, key: PropertyKey): PropertyDescriptor|undefined => {
        if (target.hasOwnProperty(key)) {
          descriptorTargetMap.set(key, 'target')
          return Object.getOwnPropertyDescriptor(target, key)
        }

        if (rawWindow.hasOwnProperty(key)) {
          descriptorTargetMap.set(key, 'rawWindow')
          const descriptor = Object.getOwnPropertyDescriptor(rawWindow, key)
          if (descriptor && !descriptor.configurable) {
            descriptor.configurable = true
          }
          return descriptor
        }

        return undefined
      },
      defineProperty: (target: microWindowType, key: PropertyKey, value: PropertyDescriptor): boolean => {
        const from = descriptorTargetMap.get(key)
        if (from === 'rawWindow') {
          return Reflect.defineProperty(rawWindow, key, value)
        }
        return Reflect.defineProperty(target, key, value)
      },
      ownKeys: (target: microWindowType): Array<string | symbol> => {
        return unique(Reflect.ownKeys(rawWindow).concat(Reflect.ownKeys(target)))
      },
      deleteProperty: (target: microWindowType, key: PropertyKey): boolean => {
        if (target.hasOwnProperty(key)) {
          if (this.escapeKeys.has(key)) {
            Reflect.deleteProperty(rawWindow, key)
          }
          return Reflect.deleteProperty(target, key)
        }
        return true
      },
    })
  }

  start (baseurl: string): void {
    if (!this.active) {
      this.active = true
      this.microWindow.__MICRO_APP_BASE_URL__ = baseurl
      if (rawWindow._babelPolyfill) rawWindow._babelPolyfill = false
      if (++SandBox.activeCount === 1) {
        effectDocumentEvent()
      }
    }
  }

  stop (): void {
    if (this.active) {
      this.active = false
      this.releaseEffect()
      this.microWindow.microApp.clearDataListener()

      this.injectedKeys.forEach((key) => {
        Reflect.deleteProperty(this.microWindow, key)
      })
      this.injectedKeys.clear()

      this.escapeKeys.forEach((key) => {
        Reflect.deleteProperty(rawWindow, key)
      })
      this.escapeKeys.clear()

      if (--SandBox.activeCount === 0) {
        releaseEffectDocumentEvent()
      }
    }
  }

  /**
   * 通过插件系统获取隔离属性和可逃逸属性
   * @param appName 应用名称
   */
  getScopeProperties (appName: string): void {
    if (typeof microApp.plugins !== 'object') return

    if (toString.call(microApp.plugins.global) === '[object Array]') {
      for (const plugin of microApp.plugins.global!) {
        if (typeof plugin === 'object') {
          if (toString.call(plugin.scopeProperties) === '[object Array]') {
            this.scopeProperties = this.scopeProperties.concat(plugin.scopeProperties!)
          }
          if (toString.call(plugin.escapeProperties) === '[object Array]') {
            this.escapeProperties = this.escapeProperties.concat(plugin.escapeProperties!)
          }
        }
      }
    }

    if (toString.call(microApp.plugins.modules?.[appName]) === '[object Array]') {
      for (const plugin of microApp.plugins.modules![appName]) {
        if (typeof plugin === 'object') {
          if (toString.call(plugin.scopeProperties) === '[object Array]') {
            this.scopeProperties = this.scopeProperties.concat(plugin.scopeProperties!)
          }
          if (toString.call(plugin.escapeProperties) === '[object Array]') {
            this.escapeProperties = this.escapeProperties.concat(plugin.escapeProperties!)
          }
        }
      }
    }
  }

  /**
   * 向原型window注入全局变量
   * @param microWindow 原型window
   * @param appName 应用名称
   * @param url app url
   */
  inject (microWindow: microWindowType, appName: string, url: string): void {
    microWindow.__MICRO_APP_ENVIRONMENT__ = true
    microWindow.__MICRO_APP_NAME__ = appName
    microWindow.__MICRO_APP_PUBLIC_PATH__ = getEffectivePath(url)
    microWindow.microApp = new EventCenterForMicroApp(appName)
    microWindow.rawWindow = rawWindow
    microWindow.rawDocument = rawDocument
  }
}
