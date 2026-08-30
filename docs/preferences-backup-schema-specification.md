# LingoFlow Preferences Backup Schema 规范

本文档定义 Preferences 在 Backup v2 中的长期实体语义与验证边界。

本规范与个人数据备份规范、Backup Schema 规范和 Backup v2 Envelope 规范共同约束可跨环境恢复的用户偏好。它不描述本地存储键、Repository API、Schema Validator 实现、Export、Restore、用户界面、云同步或账号系统。

当 Backup v2 声明支持 Preferences 时，其实体数据必须遵守本规范。本规范本身不构成对 Repository、Validator、Export、Restore 或 Envelope 接入状态的声明。

## 1. Entity and Collection Shape

Preferences 在产品语义上是单例设置集合，但在 Backup v2 中按设置项表达为 `preferences` collection：

```json
{
  "preferences": [
    {
      "key": "fontSize",
      "value": "21"
    },
    {
      "key": "appearance",
      "value": "dark"
    },
    {
      "key": "speechVoice",
      "value": null
    }
  ]
}
```

每个 item 表示一个被用户显式保存且适合跨环境恢复的 preference。item 只能包含两个自身可枚举的数据字段：

- `key`：该 preference item 的稳定语义 identity。
- `value`：该设置显式保存的完整值。

`key` 和 `value` 都是必需字段。缺少任一字段，或 item 含有 `key`、`value` 以外的字段，都会使该 item 无效。未来若需要 item 级生命周期或元数据，必须通过 Preferences Backup Entity Schema 的明确演进定义，不能作为未声明字段混入首版 item。

### 1.1 Collection Rules

`preferences` 集合必须满足以下规则：

- 必须是数组；单例对象、key-value map 或其他容器不是合法集合。
- 空数组 `[]` 是合法集合。
- 每一项必须是 plain JSON object，不能是 `null`、数组、class instance 或其他值。
- 每一项都必须完整通过 item、key、value、reserved key 与 JSON Safety 验证。
- 同一集合内不得出现重复 `key`；即使两项的 value 完全一致，也必须拒绝整个集合。
- 任意一项无效或出现重复 `key` 时，整个 `preferences` collection 必须被拒绝，不能返回或恢复部分有效集合。
- item 的数组位置不参与 identity、冲突判断或恢复优先级。

`preferences: []` 只表示“Backup 中没有显式保存的 portable preference”。它不表示：

- 展开并恢复应用默认值。
- 清空本地 Preferences。
- 删除或重置任何本地 preference。
- 证明目标环境没有其他本地或未来 preference。

### 1.2 Key Rules

`key` 必须：

- 是 string，不能为 `null`。
- 匹配 ASCII 标识规则 `^[A-Za-z][A-Za-z0-9._-]*$`。
- 原样作为 identity 使用；Validator、Export 和 Restore 不得 trim、大小写转换或 normalize。
- 通过第 6 节的 reserved / forbidden key 检查。

key identity 使用精确、区分大小写的字符串相等比较。不得为 preference item 生成随机 ID、内容 hash 或额外 identity 字段。

## 2. Missing, Default, and Explicit Value

Preferences Backup Schema 必须区分以下三种事实：

1. 某个 `key` 不存在于 collection。
2. 某个 `key` 显式存在，并保存了当前应用默认值。
3. 某个 `key` 显式存在，并保存了非默认值。

例如，collection 中没有 `fontSize` item，不等同于：

```json
{
  "key": "fontSize",
  "value": "21"
}
```

前者表示 Backup 没有携带该显式 preference；后者表示用户数据中明确保存了值 `"21"`。即使 `"21"` 恰好是当前运行时默认值，两者也不能折叠。

Backup v2 不得：

- 展开 UI 或运行时默认值。
- 把 missing storage 解释成五个默认 preference item。
- 把缺少某个 key 解释成该 key 的默认值。
- 为缺少或非法的 `value` 补默认值。
- 因应用默认值以后改变而重写备份中的显式值。

## 3. Official Portable Preferences

首版正式 portable preference keys 是：

- `fontSize`
- `lineHeight`
- `appearance`
- `speechRate`
- `speechVoice`

正式 key 的 value 必须严格符合本节。Validator、Export 和 Restore 不得通过当前 UI、宽松 writer 或运行时 fallback 修复非法输入。

### 3.1 `fontSize`

`fontSize.value` 必须是以下 string enum 之一：

```text
"18"
"20"
"21"
"23"
"25"
```

number `18`、带首尾空白的 `" 21 "`、空字符串和其他字符串都不合法。

不得 trim、执行 number/string conversion、clamp、选择最近值或 fallback。

### 3.2 `lineHeight`

`lineHeight.value` 必须是以下 string enum 之一：

```text
"1.65"
"1.85"
"2"
"2.2"
"2.4"
```

number、带首尾空白的字符串、空字符串和其他字符串都不合法。不得自动转换、trim、clamp 或 fallback。

### 3.3 `appearance`

`appearance.value` 必须是以下 string enum 之一：

```text
"system"
"light"
"dark"
```

`"system"` 表示用户明确选择“跟随系统”的 portable intent。某一时刻由系统解析得到的实际 light/dark 结果是 runtime state，不属于 Backup，也不得反向覆盖 `"system"`。

其他字符串、boolean、`null` 或运行时解析结果都不合法。不得 trim、转换或 fallback。

### 3.4 `speechRate`

`speechRate.value` 必须是以下 string enum 之一：

```text
"0.7"
"0.85"
"1"
"1.15"
```

number、带首尾空白的字符串、空字符串和其他字符串都不合法。Validator、Export 和 Restore 不得调用或复制运行时 `normalizeSpeechRate()` 的 fallback 行为来修复 Backup 输入。

### 3.5 `speechVoice`

`speechVoice.value` 必须是：

- `null`；或
- 仅包含 `name`、`lang`、`voiceURI` 三个字段的 plain JSON object。

对象形态为：

```json
{
  "name": "Samantha",
  "lang": "en-US",
  "voiceURI": "com.apple.voice.compact.en-US.Samantha"
}
```

三个字段都必须作为自身可枚举的数据字段存在，且都必须是 string：

- `name`：必须非空、至少包含一个非空白字符，且不能包含首尾空白。
- `lang`：必须非空、至少包含一个非空白字符，且不能包含首尾空白。
- `voiceURI`：允许精确空字符串 `""`；非空时不能是仅空白字符串，也不能包含首尾空白。

该边界与当前正常保存行为一致：已选择的 voice 保存 `name`、`lang` 和 `voiceURI` 三项；`voiceURI` 在浏览器未提供时仍显式保存为空字符串。宽松 writer 理论上能够留下缺少有效 `name` 或 `lang` 的异常对象，不使该异常对象成为合法的新 Backup v2 数据。

`speechVoice` 对象不允许 unknown extension，也不得保存实际 `SpeechSynthesisVoice` 对象上的其他 runtime 字段，例如 `localService`、`default` 或运行时可用状态。未来如需新的 portable voice 语义，必须通过 Schema 的明确演进定义，不能由 Validator 猜测字段。

`speechVoice` 是 portable user intent / resource hint，不是跨设备稳定 Voice ID，也不是当前设备资源存在性的证明。

Restore 必须：

- 原样保存合法的 preference value。
- 不检查目标设备当前是否存在对应 voice。
- 不根据目标设备 voice 列表过滤、替换或重写 preference。
- 不因目标 voice 缺失而把合法 value 判为冲突或无效。

运行时继续根据目标环境可用资源执行 voice fallback。该 fallback 不属于 Restore transformation，不能修改已恢复的 preference。

`speechVoice.value === null` 表示用户显式选择“自动选择”。它与 collection 中没有 `speechVoice` item 严格不同：前者是可恢复的明确用户意图，后者表示 Backup 不携带该 preference。

## 4. Unknown Preference Keys

Preferences Backup Schema 允许未来合法的 preference extension，例如：

```json
{
  "key": "futureSetting",
  "value": {
    "mode": "example"
  }
}
```

unknown preference key 必须遵守第 1.2 节的 key 规则，并且不能是第 6 节的 reserved / forbidden key。其 value：

- 必须满足第 10 节的 JSON Safety 规则。
- 必须在验证、评估、恢复和后续导出往返中原样保留。
- 不得被 trim、normalize、类型转换、补默认值或以 JSON stringify 静默丢失成员。
- 可以由当前版本安全保存而暂不应用；“保存”不授权 UI 或运行时解释未知语义。
- 必须完整参与 same-key exact-value 比较。

Preferences 不能使用完全严格的 key 白名单。正式 key 具有本规范定义的已知 value Schema；其他合法且非 reserved 的 key 进入 unknown preference compatibility 边界。

unknown value 中对象属性的名称不是 preference item identity，也不参与第 6 节针对 `item.key` 的 exact reserved-key 检查。Schema Validator 不应根据未知嵌套属性名猜测未来 preference 的业务含义。合规的数据生产者仍不得利用 unknown key/value 包装明确排除的设备身份、同步状态、运行时状态或资源数据。

因此，第 6 节是 Validator 可执行的 item identity 边界；第 5 节同时约束 Export 和数据生产者对 unknown preference 业务含义的选择。纯 Schema validation 不能仅凭 unknown value 中某个普通属性名判断整项数据是否实际表达设备本地状态。

## 5. Portable and Device-local Boundary

只有表达用户可跨环境恢复意图的设置可以进入 `preferences`。以下数据永远不进入 Preferences Backup：

- 当前设备身份，包括 `deviceId`。
- 当前系统 voice 列表、实际 `SpeechSynthesisVoice` 对象及 voice 可用性结果。
- 当前设备的权限授予状态或硬件能力。
- 已解析的 appearance、DOM class、CSS value、select 状态或其他 UI/runtime state。
- Backup reminder、dismiss 状态、最近备份时间或其他本地备份控制状态。
- Query History Migration State 或其他 migration control state。
- Dictionary 就绪状态、版本缓存、导入/下载进度与 checkpoint。
- 同步队列、远端 identity、服务端 revision 或其他 sync metadata。

这些排除项不能因为当前存储位置靠近 Preferences、当前 UI 使用它们或未来需要跨设备同步而自动成为 portable preference。

## 6. Reserved and Forbidden Keys

以下是本 Schema 首版完整、可执行的 reserved / forbidden preference key 集合：

### 6.1 Device Identity and Local Control

- `deviceId`
- `historyMigrationState`
- `migrationState`
- `migrationCompleted`
- `migrationVersion`
- `lastBackup`
- `backupDismiss`
- `backupReminder`

### 6.2 Sync Metadata

- `syncStatus`
- `remoteId`
- `serverRevision`
- `dirty`
- `lastSyncedAt`
- `vectorClock`

### 6.3 Runtime and Hardware State

- `voices`
- `currentVoice`
- `localService`
- `voiceAvailable`
- `darkMode`
- `resolvedAppearance`
- `permissionState`
- `permissions`
- `hardwareCapabilities`

### 6.4 Dictionary, Import, and Download State

- `dictionaryReady`
- `dictionaryVersion`
- `completedChunks`
- `importedRecords`
- `downloadCheckpoint`
- `dictionaryGuideDeferred`
- `dictionaryWasReady`
- `dictionaryTaskState`
- `dictionaryIntegritySnapshot`

### 6.5 Legacy Wrapper and Field Names

- `speed`
- `reading`
- `preferences.speed`
- `preferences.reading`

### 6.6 Structural Control Names

- `__proto__`
- `prototype`
- `constructor`

reserved 检查只对 item 的 `key` 执行，并按上列字符串精确、区分大小写地比较。分类标题不产生模式匹配，也不存在“名称相似即拒绝”的隐含规则。未来需要增加新的 reserved key 时，必须通过 Preferences Backup Entity Schema 的明确演进加入具体名称。

item 的 `key` 命中任一 reserved / forbidden key 时，该 item 无效，并按第 1.1 节拒绝整个 collection。不能把 reserved key 当作 unknown preference 接受。

## 7. Legacy Compatibility Boundary

Backup v2 Preferences Schema 不接受旧 wrapper 或旧字段，包括：

- `speed`
- `reading`
- `preferences.speed`
- `preferences.reading`

其中 `preferences.speed` 和 `preferences.reading` 是旧 wrapper 路径的明确表示；它们同时被保留为不可接受的 literal key，避免通过 unknown preference 边界进入新 Schema。

旧备份中的 `speed -> speechRate` 等兼容转换只属于独立 legacy backup restore 路径。新的 Preferences Schema：

- 不执行 legacy key 映射。
- 不调用运行时 normalization 修复旧值。
- 不根据旧 wrapper 推断正式 item。
- 不补造缺失的现代 preference。

本规范不修改旧 JSON Backup 格式，也不把 legacy 输入错误兼容进 Backup v2。

## 8. Identity and Exact Value

Preference item 的唯一 identity 是 `key`。

- key identity 不来自 value、collection 位置、设备、时间或内容 hash。
- 不生成随机 ID。
- 不添加 `id` 字段。
- 不因 value 改变而改变 identity。
- 不同 key 始终是独立 preference。

exact complete value 比较必须包含完整 JSON-safe value：

- primitive 按其 JSON 值比较。
- plain object 的属性顺序不影响相等性，但属性名、完整成员和值都参与比较。
- array 顺序参与比较。
- unknown preference value 的全部嵌套数据都参与比较。
- `speechVoice` 必须按完整三字段对象比较，不能只比较 `name`、`lang` 或 `voiceURI` 的子集。

比较前不得 trim、normalize、补默认值、删除 unknown data 或执行运行时 fallback。

## 9. Conflict and Restore Merge Semantics

Preferences Restore 是 per-key merge / preserve，不是整个 Preferences object 的 replace 或 mirror。

### 9.1 Per-key Results

- 本地不存在 incoming key：该 item 为 `restorable`，成功写入后为 `restored`。
- 本地存在 same key，且 complete value exact equal：该 item 为 `unchanged`，不重复写入。
- 本地存在 same key，但 complete value 不同：该 item 为 `conflict`，本地 value 保持不变。
- different key：独立评估和恢复，不参与互相的胜负判断。

多个合法 item 必须分别产生 `restored`、`unchanged` 或 `conflict`。一个合法 conflict 不得阻止其他独立且 restorable 的 preference item 恢复。

### 9.2 Missing Keys Preserve Local Data

Backup 缺少某个 key 时，本地该 key 必须保留。缺失不表示默认、删除、reset 或镜像同步。

本地存在但当前版本不理解的合法 preference 也不得因为 Backup 未包含它而丢失。

### 9.3 Forbidden Automatic Resolution

Preferences 首版没有 `createdAt`、`updatedAt`、per-key timestamp、revision 或 tombstone。Validator、Export 和 Restore 不得生成或补造这些字段，也不能据此声称存在可靠的时间先后关系。

冲突不得通过以下方式静默解决：

- LWW。
- incoming overwrite。
- whole Preferences object overwrite。
- local 或 incoming 整体获胜。
- 根据 Backup 创建时间或 Envelope 创建时间决定 preference 胜者。
- 对 `speechVoice` object 自动逐字段 merge。
- 根据运行时默认值或目标设备资源选择胜者。

## 10. JSON Safety and Snapshot Rules

Preference item 及其 value 必须是纯数据，并可被 JSON 完整、安全地表达。

合法 JSON-safe value 可以由以下类型递归组成：

- `null`
- boolean
- string
- finite number
- 非稀疏数组
- plain JSON object

本规范中的 plain JSON object 只接受原型为 `Object.prototype` 或 `null` 的对象。两个不同路径可以引用同一个非循环 plain object；validated snapshot 将它们表达为相同内容的独立 JSON tree 分支。只有实际 cycle 才按下列规则拒绝。

必须拒绝：

- `undefined`
- function
- Symbol
- BigInt
- `NaN`、`Infinity` 或其他非有限 number
- cycle 或重复引用形成的循环结构
- sparse array 或带非标准 own property 的数组
- getter、setter 或其他 accessor
- symbol-keyed own property
- 不可枚举 own data property 或其他会被普通 JSON 表达静默丢失的数据异常
- Date、Map、Set、class instance 或其他非 plain object

Validator 不得通过读取 accessor 来验证，也不得执行 getter 或 setter。不得依赖 `JSON.stringify()` 静默丢弃非法成员来把输入变成合法数据。

输入合法时，验证结果必须是独立、稳定的 snapshot，不与输入共享可变 object 或 array 引用。验证过程不得修改输入。

第 6 节的 reserved policy 针对 preference item 的 `key`。unknown preference value 内的普通对象属性名不是 preference key；它们接受本节的 JSON Safety 检查，但不递归套用 reserved preference key 列表。正式 `speechVoice` value 仍须遵守第 3.5 节的精确三字段形态。

## 11. Delete and Reset Boundary

首版 Preferences Backup v2 不定义 tombstone。

- Backup 中缺少 key 不表示删除。
- `preferences: []` 不表示清空或 reset。
- Restore 不删除本地额外 key。
- Restore 不传播跨设备 preference 删除。
- 对当前有显式“自动”语义的设置，必须使用其合法显式 value 表达，例如 `speechVoice: null`，不能用缺少 item 代替。

本规范不设计 reset event、delete propagation 或 cross-device preference deletion。未来若需要同步“重置设置”或删除显式 preference，必须单独设计可区分缺失与删除的生命周期语义。

## 12. Envelope Boundary

长期目标中的实体注册片段为：

```text
schema.preferences = "1"
data.preferences = []
```

以上只展示完整 Envelope 内 `schema` 与 `data` 的 Preferences 对应项，不是一个可独立使用的完整 Envelope；完整 Envelope 仍必须包含其外层字段及 required Article entity。

`preferences` 是 optional Backup entity。Article 继续是 required entity，因此：

- Article-only Envelope 继续合法。
- 现有 Article + Favorite + Favorite Learning State 三实体 Envelope 继续合法。
- 现有五实体 Envelope 继续合法。
- 未声明 `preferences` 的旧 Envelope 不具有读取、评估或修改本地 Preferences 的权限。
- 声明 `preferences` 时，`schema.preferences` 与 `data.preferences` 必须一一对应。

Preferences 不属于 `QUERY_HISTORY_ENTITIES`。声明 Preferences 不得触发：

- Query History Migration Coordinator。
- Migration State 读取、写入或 finalize。
- QueryHistoryProjector。
- Vocab rebuild 或 Vocab 修改。
- Favorite Learning side effect。

Envelope 只声明实体类型与 Schema 版本，不解释具体 preference value、解决冲突或执行恢复。本节描述长期接入边界，不修改当前 Envelope，也不把尚未实现的接入描述为现状。

## 13. Export Boundary

未来 Preferences Backup Export 只能导出用户真实、显式保存且符合本规范的 portable preferences。

- missing preference storage 导出 `preferences: []`。
- 存储中只有 `appearance: "dark"` 时，只导出 `{ "key": "appearance", "value": "dark" }`。
- 显式保存的默认值仍应作为对应 item 导出。
- 不从 UI control、CSS、DOM、当前系统状态或运行时 defaults 补齐未保存的 key。
- 不把 runtime fallback 后的 speech rate、voice 或 appearance 结果当成显式 preference。
- 不导出第 5、6 节排除的本地或运行状态。

无法安全读取存储或读取到 malformed preference 数据时，不能把它伪装成 missing storage 或空 collection。Export 必须明确失败或拒绝，不能生成声称 Preferences 范围完整的 ready Backup。

这些规则不绑定具体存储方式或 Repository API，只定义 Export 必须保留的业务事实边界。

## 14. Out of Scope and Long-term Principles

本规范不设计：

- localStorage key、数据库表或其他持久化布局。
- Repository、Validator、Export、Restore 或 UI API。
- UI select、DOM、CSS 或 Web Speech API 的具体实现。
- 云同步、账号、后端、CRDT 或跨设备实时协调。
- 冲突 UI、批量覆盖操作或 reset workflow。
- 未来 timestamp、revision 或 tombstone 的具体模型。

本规范坚持以下长期原则：

- portable user intent 与 device-local/runtime state 分离。
- missing、显式默认值和显式非默认值是不同事实。
- key 是稳定语义 identity，冲突按 key 独立处理。
- 未知合法 preference 可无损往返，但不得绕过 reserved key 边界。
- 运行时 fallback 不是 Restore transformation。
- 未在本规范中定义的未来能力不能被描述为当前已实现。
- 本规范是长期数据合同，不是当前版本开发日志。
