// 物品信息格式化: 自定义名称、Lore、耐久、附魔

function stripLegacy(s) {
  return String(s).replace(/§./g, '')
}

// 递归提取 NBT 结构里的文本: {type:'compound', value:{text:{...}, extra:{...}}} 
// 或 {type:'list', value:[...]} 或 {type:'string', value:'...'}
function nbtText(node, depth = 0) {
  if (node == null || depth > 12) return ''
  if (typeof node === 'string') return stripLegacy(node)
  if (typeof node === 'number' || typeof node === 'boolean') return String(node)
  if (Array.isArray(node)) return node.map((n) => nbtText(n, depth + 1)).filter(Boolean).join('')
  if (typeof node !== 'object') return ''
  // NBT 标量
  if (node.type && typeof node.value === 'string') return stripLegacy(node.value)
  // NBT compound/list: 遍历 value 递归
  if (node.type && node.value !== null && typeof node.value === 'object') {
    // list 的 value 是数组: 直接递归
    if (Array.isArray(node.value)) return node.value.map((n) => nbtText(n, depth + 1)).filter(Boolean).join('')
    const parts = []
    // 优先取 text 字段(chat component 的文本), 再取 extra(子组件)
    if (node.value.text !== undefined) parts.push(nbtText(node.value.text, depth + 1))
    if (node.value.extra !== undefined) parts.push(nbtText(node.value.extra, depth + 1))
    if (parts.some((p) => p)) return parts.filter(Boolean).join('')
    // 没有 text/extra: 遍历所有字段(可能是嵌套结构), 跳过 type 等元数据
    return Object.values(node.value)
      .filter((v) => v !== null && typeof v === 'object')
      .map((v) => nbtText(v, depth + 1))
      .filter(Boolean)
      .join('')
  }
  // 普通对象(chat component): text 可能是 string 或 NBT 包装 {type:'string',value}, 还有 extra
  if (node.text !== undefined) {
    const t = nbtText(node.text, depth + 1)
    if (t) return t
  }
  if (node.extra !== undefined) return nbtText(node.extra, depth + 1)
  return ''
}

// 解析 Minecraft 文本组件 (JSON component / legacy 字符串 / NBT 结构) 为纯文本
export function decodeText(input) {
  if (input == null) return ''
  if (typeof input === 'number' || typeof input === 'boolean') return String(input)
  if (typeof input === 'string') {
    const s = input.trim()
    if (s.startsWith('{') || s.startsWith('["') || (s.startsWith('"') && s.endsWith('"'))) {
      try {
        return decodeText(JSON.parse(s))
      } catch {
        /* 不是 JSON, 按普通文本处理 */
      }
    }
    return stripLegacy(s)
  }
  if (Array.isArray(input)) {
    return input.map(decodeText).filter(Boolean).join('')
  }
  // NBT 结构: {type:'compound', value:{字段名: {type, value}}} (1.20.5+ 组件数据未简化)
  // value 里的 text/extra 是 {type:'string'/'list', value: ...} 包装, 统一递归提取字符串
  if (input && typeof input === 'object' && input.type && input.value !== null && typeof input.value === 'object' && !Array.isArray(input.value)) {
    const out = nbtText(input)
    if (out != null && out !== '') return out
  }
  // NBT 标量: {type:'string'/'int'/'byte', value:'文本'}
  if (input && typeof input === 'object' && input.type && (typeof input.value === 'string' || typeof input.value === 'number' || typeof input.value === 'boolean')) {
    return String(input.value)
  }
  if (typeof input === 'object') {
    const parts = []
    if (typeof input.text === 'string') parts.push(decodeText(input.text))
    if (typeof input.translate === 'string') {
      const with_ = Array.isArray(input.with) ? input.with.map(decodeText).filter(Boolean) : []
      const known = { 'chat.type.text': '<%s> %s' }
      const tpl = known[input.translate] ?? input.translate
      if (with_.length) {
        let i = 0
        parts.push(tpl.replace(/%s/g, () => (i < with_.length ? with_[i++] : '')).replace(/%1\$s/g, () => with_[0] ?? '').replace(/%2\$s/g, () => with_[1] ?? ''))
      } else {
        parts.push(tpl)
      }
    }
    if (Array.isArray(input.extra)) parts.push(decodeText(input.extra))
    return parts.filter(Boolean).join('')
  }
  return String(input)
}

export function itemTitle(item) {
  if (!item) return null
  try {
    if (item.customName) return decodeText(item.customName)
  } catch { /* ignore */ }
  try {
    // 宽容解析 NBT display.Name: raw(nbt.value.display.value.Name.value) 或 simplified(直接字符串)
    const v = item.nbt?.value?.display?.value
    const raw = v?.Name?.value
    if (raw) return decodeText(raw)
    const simp = item.nbt && nbtSimplifiedName(item.nbt)
    if (simp) return decodeText(simp)
  } catch { /* ignore */ }
  return item.displayName || item.name
}

// 宽容取 nbt simplify 后的 display.Name(兼容 1.21+ simplified 结构)
function nbtSimplifiedName(nbtObj) {
  try {
    const d = nbtObj.simplify?.()?.display
    return d?.Name ?? null
  } catch {
    return null
  }
}

// 物品 Lore: 1.20.5+ 的 item.customLore, 以及 NBT 里的 display.Lore(兼容 raw/simplified/list/string)
export function itemLore(item) {
  if (!item) return []
  const out = []
  try {
    if (Array.isArray(item.customLore)) out.push(...item.customLore.map(decodeText))
  } catch { /* ignore */ }
  try {
    const v = item.nbt?.value?.display?.value
    const raw = v?.Lore?.value
    if (Array.isArray(raw)) out.push(...raw.map(decodeText))
    else if (typeof raw === 'string') out.push(decodeText(raw))
  } catch { /* ignore */ }
  try {
    // simplified 结构: display.Lore 是字符串数组或字符串
    const simp = item.nbt?.simplify?.()?.display?.Lore
    if (Array.isArray(simp)) out.push(...simp.map(decodeText))
    else if (typeof simp === 'string') out.push(decodeText(simp))
  } catch { /* ignore */ }
  return out.filter((s) => s != null && String(s).length > 0)
}

function enchantDisplayName(registry, id) {
  try {
    const list = registry?.enchantmentsArray || Object.values(registry?.enchantments || {})
    const e = list.find((x) => x.id === id)
    return e?.displayName || e?.name || String(id)
  } catch {
    return String(id)
  }
}

// 附魔 (legacy NBT ench + 现代组件 minecraft:enchantments), 尽力而为
export function itemEnchants(item, registry) {
  if (!item?.nbt) return []
  try {
    const v = item.nbt.value
    const ench = v.ench?.value
    if (Array.isArray(ench)) {
      return ench.map((e) => {
        const id = e.value?.id?.value
        const lvl = e.value?.lvl?.value
        return `${enchantDisplayName(registry, id)} ${lvl ?? ''}`.trim()
      })
    }
    const comps = v.components?.value ?? v['minecraft:components']?.value
    const encObj = comps?.['minecraft:enchantments']?.value ?? comps?.['minecraft:enchantments']
    if (encObj && typeof encObj === 'object') {
      const inner = encObj.value ?? encObj
      return Object.entries(inner)
        .map(([key, val]) => {
          const lvl = val?.value?.lvl?.value ?? val?.lvl?.value ?? val?.value ?? val
          return `${String(key).replace('minecraft:', '')} ${lvl ?? ''}`.trim()
        })
    }
  } catch { /* ignore */ }
  return []
}

export function durabilityOf(item, registry) {
  if (!item) return undefined
  try {
    const max = registry?.itemsByName?.[item.name]?.maxDurability
    if (!max) return undefined
    const used = item.durabilityUsed ?? 0
    return { remaining: max - used, max }
  } catch {
    return undefined
  }
}

export function formatItem(item, registry, slot) {
  if (!item) return null
  return {
    slot,
    name: item.name,
    title: itemTitle(item),
    count: item.count,
    durability: durabilityOf(item, registry),
    lore: itemLore(item),
    enchants: itemEnchants(item, registry),
  }
}

export function isFoodItem(item, registry) {
  if (!item) return false
  try {
    return (item.food ?? registry?.itemsByName?.[item.name]?.food ?? 0) > 0
  } catch {
    return false
  }
}

export function isBlockItem(item, registry) {
  if (!item) return false
  try {
    return Boolean(registry?.blocksByName?.[item.name])
  } catch {
    return false
  }
}
