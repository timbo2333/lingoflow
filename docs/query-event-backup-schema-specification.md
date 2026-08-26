# LingoFlow QueryEvent Backup Schema 规范

本文档定义 QueryEvent 在 Backup v2 中的长期实体语义与验证边界。

本规范与 Backup Schema 规范、个人数据备份规范和 Backup v2 Envelope 规范共同约束查询事件的备份表达。它描述业务事实，不描述本地存储方式、代码接口、Schema Validator、Export、Restore、用户界面或云同步协议。

当 Backup v2 声明支持 QueryEvent 时，其实体数据必须遵守本规范。本规范本身不构成对 Repository、Validator、Export、Restore 或 Envelope 接入状态的声明。

## 1. QueryEvent Backup Entity

在声明 QueryEvent 的 Backup Envelope 中，`queryEvents` 应作为独立的个人数据实体集合。集合中的每一项表达一次已经发生的查询事实，而不是当前 Vocab 聚合、搜索索引、词典资源或本地存储记录。

QueryEvent Backup Entity 应完整表达：

- 事件的稳定身份。
- 事件发生时的来源设备信息。
- 被查询文本及展示文本快照。
- 当时保存的精简词典结果快照。
- 查询来源与事件发生时间。

QueryEvent 没有 `createdAt`、`updatedAt`、`deletedAt` 或 tombstone 生命周期。首版集合采用 current-set / hard-delete 边界，具体删除语义见第 10 节。

## 2. Field Structure

### 2.1 Required Fields

每个 QueryEvent Backup Entity 必须包含以下十个正式字段：

- `id`
- `deviceId`
- `word`
- `displayWord`
- `phonetic`
- `pos`
- `meaning`
- `dictionaryFound`
- `source`
- `timestamp`

这些字段共同表达当前 QueryEvent 的完整事件事实。缺失任意正式字段时，该记录无效。验证、导出和恢复不得通过当前 writer 的默认行为推断、生成或补齐缺失字段。

### 2.2 Optional Fields

本 Schema 没有已知的可选正式字段。

`phonetic`、`pos` 和 `meaning` 即使没有可用快照，也必须以显式字符串表达；空字符串是本 Schema 接受的既有事实值，不授权 Validator 或 Restore 为缺失字段补空字符串。

未来事件事实或快照扩展可以作为 unknown field 出现，但必须遵守第 8 节的兼容边界。新增正式字段及其必需性需要通过 QueryEvent Backup Entity Schema 自身的版本边界明确演进。

### 2.3 Field Type Rules

| 字段 | 类型与必需性 | 空字符串 | `null` | 首尾空白 | 语义 |
| --- | --- | --- | --- | --- | --- |
| `id` | 必需的 string | 禁止 | 禁止 | 禁止 | QueryEvent 的 opaque stable identity |
| `deviceId` | 必需的 string | 禁止 | 禁止 | 禁止 | 事件创建来源的 provenance snapshot |
| `word` | 必需的 string | 允许精确的 `""`；禁止仅空白字符串 | 禁止 | 非空时禁止 | 事件保存的 Vocab aggregation key 事实；`""` 表示没有可表达的规范化聚合 key |
| `displayWord` | 必需的 string | 禁止 | 禁止 | 禁止 | 用户查询时保存的展示文本快照 |
| `phonetic` | 必需的 string | 允许 | 禁止 | 允许并原样保留 | 当时保存的音标快照 |
| `pos` | 必需的 string | 允许 | 禁止 | 允许并原样保留 | 当时保存的词性快照 |
| `meaning` | 必需的 string | 允许 | 禁止 | 允许并原样保留 | 当时保存的释义快照 |
| `dictionaryFound` | 必需的 boolean | 不适用 | 禁止 | 不适用 | 当次查询是否保存了词典命中事实 |
| `source` | 必需的 string enum | 禁止 | 禁止 | 不适用 | 只能是 `"article"` 或 `"search"` |
| `timestamp` | 必需的 canonical UTC string | 禁止 | 禁止 | 禁止 | 事件发生时间 |

`id`、`deviceId` 和 `displayWord` 必须至少包含一个非空白字符。它们可以包含有业务意义的内部空白，但不能包含首尾空白。

`word` 必须作为 string 字段存在，但允许精确的空字符串 `""`。当 `word` 非空时，它必须至少包含一个非空白字符且不能包含首尾空白；仅由空白字符组成的字符串不合法。

`word === ""` 表示该 QueryEvent 是一次真实发生且必须保留的查询事实，但该次查询没有可表达的规范化 Vocab aggregation key。空 `word` 不使事件无效，也不削弱 `displayWord` 的 required、non-empty string 规则。

Validator、Export 和 Restore 不得 trim 或 normalize `word`，不得根据 `displayWord`、Dictionary 结果或其他字段补造、替换 `word`，也不得把合法的 `""` 解释为字段缺失。

`phonetic`、`pos` 和 `meaning` 的显式空字符串、仅空白字符串及带首尾空白的字符串都按原始快照处理。Schema 不把它们视为缺失字段，也不得自动 trim 或规范化。

`deviceId` 是事件来源事实的一部分。Restore 必须保留它，但不得把它设置为目标环境的当前设备身份，也不得把它解释为同步路由、远端账号或冲突胜负依据。

所有字段都必须是实体自身可枚举的 JSON 数据字段。不能从原型链、accessor 或其他运行时行为推断字段；验证不得执行 getter 或 setter。

验证、导出和恢复不得：

- 自动 trim、大小写转换、Unicode 规范化或其他字符串转换，包括对 `word` 的 normalize。
- 自动在字符串、布尔值、数字或其他类型之间转换。
- 自动补空字符串、布尔值、来源、设备身份或其他默认值。
- 自动生成或替换 `id`。
- 自动生成、刷新、解析后重写或补齐 `timestamp`。
- 修改 Schema 输入。

### 2.4 Collection Rules

`queryEvents` 集合必须满足以下规则：

- 集合必须是数组；对象 map、单个实体或其他容器不是合法的 `queryEvents` 集合。
- 空数组是合法集合，表示该备份范围内当前没有 QueryEvent。
- 每个数组项都必须是普通 JSON 对象，不能是 `null`、数组或其他值。
- 每个数组项都必须完整通过 QueryEvent 字段、时间、unknown field 与 reserved field 验证。
- 同一集合内不得出现重复 `id`；即使两个重复项完全一致，也必须拒绝整个集合。
- 任意一项无效或出现重复 `id` 时，整个 `queryEvents` 集合应在首次写入前被拒绝，不能部分接受有效项。
- 不同 `id` 即使具有相同的 `word`、`timestamp`、`deviceId` 或全部业务内容，仍是合法的独立事件。
- 当 Envelope 声明 `queryEvents` 时，该数组表达导出范围内 QueryEvent 的完整 current-set，而不是默认意义上的分页或任意子集；这不改变第 10 节“集合缺失不传播删除”的规则。

本地当前可能使用其他容器组织 QueryEvent，但本 Schema 只定义 Backup Entity 数组，不把本地 map key、集合位置或存储布局作为身份。

## 3. Stable Identity

`id` 是 QueryEvent 的稳定身份。

- ID 不由事件内容、`word`、`displayWord`、`timestamp`、`deviceId`、词典快照、集合位置或其组合生成。
- 本规范不锁定 UUID、随机数、hash 或其他具体 ID 生成算法。
- ID 一旦建立，在导出、恢复、重复恢复和跨环境传输中保持不变。
- Restore 必须原样保留备份中的 `id`，不得重新生成替代身份。
- 已 hard-delete 的事件 ID 不应被新事件复用。
- 同 ID 只表示同一事件身份，不表示接收方可以覆盖不同内容。

同一集合中的重复 ID 属于结构不明确，应整批 `rejected`。本地与备份之间的同 ID 差异属于领域冲突，按第 7 节处理。

## 4. Immutable Event Semantics

QueryEvent 是 immutable event fact。事件一旦建立，其正式字段和合法 unknown fields 共同构成不可原地改写的事件事实。

Backup Restore 不得：

- 更新已有 QueryEvent 的字段。
- 在本地记录与备份记录之间逐字段 merge。
- 使用 last-write-wins 或时间较新者覆盖整条事件。
- 修改 `timestamp` 或 `deviceId`。
- 重新查询 Dictionary 后覆盖 `dictionaryFound`、`phonetic`、`pos` 或 `meaning`。
- 使用另一个事件的快照补齐当前事件。

当前事件创建路径没有业务更新语义，但现有删除采用 hard delete。因此 QueryEvent 是“存在期间不可变”的事件事实，不是带 tombstone 的永久 append-only 日志。

若未来需要表达事件更正、撤销或软删除，必须通过新的明确实体或生命周期 Schema 设计，不能静默改变本 Schema 中已有事件的含义。

## 5. Query and Dictionary Snapshot Boundary

`word` 和 `displayWord` 表达同一次查询的两个不同事实边界：

- `word` 是该事件保存的 Vocab aggregation key 事实；精确的 `""` 表示该事件没有可表达的规范化聚合 key。
- `displayWord` 是事件发生时保存的展示文本快照。

两者不能互相生成或替代。`word` 为空时不得从 `displayWord` 补造聚合 key；大小写或文本相同也不改变事件身份。

`phonetic`、`pos`、`meaning` 和 `dictionaryFound` 是当次事件保存的精简 Dictionary 结果快照：

- 它们不是当前 Dictionary 的实时真值。
- Dictionary 更新、删除或不可用不能使 QueryEvent 失效。
- Restore 不得重新查询 Dictionary、lemma 或其他资源来补造或覆盖这些字段。
- `dictionaryFound` 是该次事件的布尔事实，不是从当前资源重新计算的派生状态。

QueryEvent 不得嵌入完整 Dictionary 条目库、Dictionary 数据集、lemma 映射集合或其他可重建离线资源。未来合法的单项事件快照扩展仍必须保持“表达该次查询所需的有限事实”边界，不能借 unknown field 携带完整资源。

## 6. Timestamp Rules

`timestamp` 表示 QueryEvent 实际发生时间，必须使用规范化的 ISO 8601 UTC 字符串，采用带毫秒和 `Z` 时区标记的形式，例如：

```text
2026-08-24T10:00:00.000Z
```

唯一接受的形式为 `YYYY-MM-DDTHH:mm:ss.sssZ`，并且字段值必须表示有效的日历日期和时间。

不得接受或自动处理：

- number timestamp 或 epoch 数值。
- 本地时间字符串。
- 带其他时区 offset 的字符串。
- 缺少毫秒或 `Z` 的字符串。
- 仅能被宽松日期解析器理解的其他字符串。
- 通过 trim、格式转换或补时间变成合法的输入。

Restore 必须原样保留合法 `timestamp`，不能把导入时间、恢复时间或目标设备时间写成事件时间。

## 7. Restore Conflict Principles

QueryEvent Restore 使用稳定 ID 和完整事件内容进行保守判断。

### 7.1 Local ID Does Not Exist

本地不存在该 `id`，且记录与整个集合均已通过 Schema validation 时，可以按备份中的原始身份和完整内容返回 `restored`。

### 7.2 Same ID and Exact Same Content

本地与备份记录的全部正式字段和合法 unknown fields 完全一致时，结果为 `unchanged`，不需要写入。

结构相等比较不依赖普通 JSON 对象的属性排列顺序；数组元素顺序和所有 JSON 值仍属于内容。比较不得忽略 unknown fields，也不得先 trim、规范化或补默认值。

### 7.3 Same ID and Different Content

同一 `id` 的任意正式字段、快照、时间、设备来源或合法 unknown field 不一致时，结果为 `conflict`。

- 冲突不是另一条新事件。
- 冲突不得通过字段 merge、LWW、时间比较或词典刷新自动解决。
- 本地记录必须保持不变。
- 合法但冲突的实体不能被误报为 Schema `rejected`。

### 7.4 Different IDs With Equal Content

不同 `id` 即使 `word`、`timestamp`、`deviceId`、Dictionary snapshot 和全部 unknown fields 相同，也表示独立事件。

- 两者都应保留。
- 不按内容去重。
- 不把一个事件改挂到另一个 ID。
- 对不同 ID，`deviceId` 或 Dictionary snapshot 的相同或不同都不构成身份推导规则；对相同 ID，这些字段的任何差异仍按第 7.3 节构成 `conflict`。

## 8. Unknown Field Compatibility

QueryEvent Backup Schema 允许未来合法的 event fact 或 snapshot extension。

- unknown field 必须可以由 JSON 完整、安全地表达。
- 接收方必须在验证、评估、恢复及后续导出往返中原样保留合法 unknown field。
- exact-match 比较必须包含所有 unknown field 及其嵌套内容。
- unknown field 不参与 ID 推导、内容去重或自动冲突裁决。
- Validator、Export 和 Restore 不得修改输入对象或其中的 unknown field。
- 接收方不能无损保留合法 unknown field 时，不得执行会丢失该字段的破坏性恢复。

合法 JSON-safe 值可以由 `null`、boolean、string、有限 number、非稀疏数组和普通 JSON 对象递归组成。以下内容不是合法备份字段：

- `undefined`、function、Symbol 或 BigInt。
- `NaN`、`Infinity` 或其他非有限 number。
- 稀疏数组、循环引用、accessor、原型行为或非普通 JSON 对象。

unknown field 不能绕过第 9 节的 reserved / forbidden 边界。

## 9. Reserved and Forbidden Fields

以下属性名称属于本 QueryEvent Schema 的 reserved fields。除本规范明确的正式字段外，它们在 QueryEvent 的任何嵌套层级出现时都应使记录无效：

- Vocab aggregation：`count`、`articleCount`、`searchCount`、`firstSeen`、`lastSeen`。
- Derived Vocab containers：`vocab`、`vocabCache`。
- Lifecycle / tombstone：`createdAt`、`updatedAt`、`deletedAt`、`tombstone`。
- Migration control：`migrationState`、`migrationCompleted`、`migrationVersion`。
- Sync metadata：`syncStatus`、`remoteId`、`serverRevision`、`dirty`、`lastSyncedAt`、`vectorClock`。
- Local derived / index：`normalizedKey`、`searchIndex`。
- Complete resource containers：`dictionaryResource`、`dictionaryEntries`、`dictionaryData`、`lemmaResource`、`lemmaMappings`、`lemmaData`。

QueryEvent 还明确禁止：

- 当前 Vocab 聚合或其局部副本。
- QueryEvent 的创建、更新、删除或 tombstone 生命周期字段。
- 同步队列、服务端状态、远端 revision 或其他 sync metadata。
- 本地检索索引、规范化缓存或 UI 状态。
- 完整 Dictionary / lemma resource，无论使用何种字段名包装。

上列具体 reserved field 名称构成可由结构验证递归执行的禁止规则，不能通过嵌套对象、数组或 unknown-field 机制进入 QueryEvent。

“不得嵌入完整 Dictionary / lemma resource”同时是 QueryEvent Entity 与 Export 的语义边界。仅凭任意 unknown field 的名称和 JSON 形状，Schema validation 不负责猜测其是否伪装成完整资源；合规的数据生产者不得利用这一不可判定性规避边界，接收方也不应使用启发式内容识别误拒合法的未来单项事件快照 extension。

未来如需改变 reserved 名称或引入新的正式事实，应通过 QueryEvent Backup Entity Schema 的版本边界明确演进。

## 10. Delete Semantics

本 Schema 首版继续采用 current-set / hard-delete 语义：

- Backup 只包含导出时当前仍存在的 QueryEvent。
- `queryEvents` 中缺少某个 ID 不表示该事件已删除。
- Restore 不根据集合缺失传播删除，也不删除本地额外事件。
- QueryEvent 不包含 `deletedAt`、`tombstone` 或其他删除事实。
- 旧备份可能重新引入用户后来 hard-delete 的 QueryEvent。

这是首版明确接受的限制。本规范不在当前阶段引入 QueryEvent tombstone、删除日志、永久删除证明或跨备份删除传播。

## 11. Vocab and Migration State Boundary

Vocab 不进入 Backup v2。

- Vocab 是 Derived Data，也是 Derived/Rebuildable View。
- 查询次数、Article/Search 来源计数、首次和最近查询时间以及展示聚合都不是独立 QueryEvent 字段。
- Vocab 应由 `queryEvents` 与 `historyBaselines` 两个事实集合重建。
- Vocab 不能覆盖、修改或补造 QueryEvent 与 History Baseline。

Migration State 也不进入 Backup v2。

- Migration State 是 local migration control state，不是 Personal Data Entity。
- 它只用于保证 legacy history migration 的一次性边界。
- 它不参与 QueryEvent identity、exact-match、冲突判断或 Vocab 重建。
- Backup Schema 不绑定其本地名称、存储位置或实现方式。

## 12. QueryEvent and History Baseline Boundary

QueryEvent 与 History Baseline 都是查询历史的事实输入，但表达不同层级：

- QueryEvent 表达一次可识别的现代查询事件。
- History Baseline 表达无法还原为逐次事件的 legacy aggregate facts。

同一次查询事实不得同时进入 QueryEvent 和 History Baseline。Schema validation 可以验证各集合自身的结构，但不能仅凭单词、计数或时间可靠证明两个集合是否重叠。合规的迁移与生成边界必须在创建 Backup Entity 之前防止重复事实。

Restore 不得从 Vocab 反向生成 QueryEvent，也不得把 History Baseline 拆分为伪造的逐次事件。

## 13. Envelope Boundary

Backup Envelope 负责在未来声明 `queryEvents` 集合及其 Entity Schema 版本，并承载对应数据。Envelope 不负责验证事件字段、解决身份冲突、解释删除或执行恢复。

- Envelope 中的 Schema 声明和数据集合必须明确对应。
- Envelope 合法只表示容器和集合声明可识别，不表示 QueryEvent 可以安全恢复。
- 字段验证、批内 ID 检查、领域冲突评估和安全写入属于 Envelope 之后的独立边界。
- 本规范不注册新实体，也不新增或改变 Backup Envelope 的外层结构。

## 14. Legacy Backup Boundary

旧 JSON Backup 的 legacy merge 仍存在一个独立问题：文件可能同时包含 `queryEvents` 与派生 `vocab`，但不包含明确的 History Baseline。若旧 Restore 把该 `vocab` 再转换为 Baseline，就可能与 `queryEvents` 重复表达同一查询事实。

该问题属于独立的 legacy Restore issue，不属于新 QueryEvent Schema 的兼容输入：

- 新 `queryEvents` 集合不接受旧 map container 或 Vocab 数据。
- QueryEvent Schema 不从 `vocab` 生成事件或 Baseline。
- QueryEvent Schema 不推断旧文件中的 Vocab 是否与事件重叠。
- 新 Validator、Repository 或 Restore 不应为兼容该错误输入而削弱稳定身份、不可变事件或事实分层。

本规范不声称该 legacy Restore 问题已解决，也不修改旧 JSON Backup。

## 15. Out of Scope

本规范不设计：

- localStorage key、数据库、map container 或其他本地持久化布局。
- Repository、Schema Validator、Export、Restore 或其 API。
- Backup v2 Envelope 的实体注册或实现修改。
- 具体 ID 生成算法。
- Vocab projector、查询聚合算法或 UI 展示。
- QueryEvent tombstone、删除同步或永久清理机制。
- 旧 JSON Backup 的迁移与恢复修复。
- 云同步、账号、后端、CRDT、vector clock 或网络传输协议。
