# LingoFlow Cloud Sync Contract 规范

本文档定义 LingoFlow 云同步的长期合同。它建立在现有实体 Schema、Repository、稳定身份和本地持久化能力之上，描述用户数据如何在本地设备与账号所属的云端记录之间安全收敛。

本规范不记录版本开发历史或当前代码实现状态，不绑定云服务商、数据库产品、认证供应商、网络框架或用户界面。它不实现服务器、账号系统、同步客户端、冲突界面或后台任务。

本规范与以下长期边界共同生效：

- LingoFlow 同步数据模型规范。
- Backup v2 Format 与 Envelope 规范。
- Article、Favorite、Favorite Learning State、Preferences、QueryEvent 和 History Baseline 的现有实体与 Backup Schema 规范。

若本规范与某个实体的正式 Schema 在字段意义、身份或生命周期上产生冲突，应停止该实体的同步接入并先修正规范；同步层不得通过改写实体、填充保留字段或降低验证要求来绕过冲突。

## 1. Purpose and Scope

Cloud Sync 负责在经过认证的同一用户账号所属设备之间持续传输用户数据变化，并提供：

- 账号归属与租户隔离。
- 本地离线修改的可靠排队。
- 可重试且幂等的上传。
- 基于服务端 revision 的并发检查。
- 基于 change cursor 的增量下载。
- 删除事实的传播与防复活。
- 冲突的保守保留。
- 事实变化后的派生视图重建。

Cloud Sync 不负责：

- 替代本地 Repository 或本地持久化。
- 把网络可用性变成核心功能的前置条件。
- 把 Backup Envelope 当作同步传输格式。
- 通过一套全局 LWW 规则解决所有冲突。
- 上传可重建资源、派生缓存或本地控制状态。
- 提供实时多人协作、CRDT 或自动正文合并。

## 2. Local-first Principle

LingoFlow 保持 local-first：

- 用户的普通读取和写入首先作用于本地 Domain Repository。
- 断网、服务器不可用、账号 session 过期或同步暂停时，核心本地能力仍然可用。
- 本地成功写入不依赖远端确认。
- 同步通过 durable change capture / outbox 观察本地变化，而不是让 UI 直接写远端。
- 远端变化必须经过实体 Schema、同步关系检查和 Domain apply 边界，不能直接写入本地存储。
- 云端是同一账号多设备之间的同步协调者，不取代用户的本地工作副本。

网络失败不等于业务写入失败。同步层应保留待上传 mutation，并在重新联网后继续处理。涉及删除、unset 或其他无法仅通过当前集合扫描恢复的操作时，删除意图必须先被 durable 保存；同步层不得因丢失删除意图而允许旧设备重新引入已删除事实。

## 3. Layered Architecture

长期同步链路为：

```text
UI / Domain Operation
        ↓
Local Repository
        ↓
Local Entity Persistence
        ↓
Change Capture / Durable Outbox
        ↓
Authenticated Sync API
        ↓
Server-owned Record + Revision
        ↓
Ordered Change Log / Cursor
        ↓
Durable Local Inbox
        ↓
Schema Validation / Remote Apply / Conflict Journal
        ↓
Derived View Rebuild
```

每一层只承担自己的责任：

- Repository 保证本地实体身份、字段、生命周期和持久化规则。
- Change Capture 记录本地 mutation，不重新定义实体。
- Outbox 保证离线、重试和进程重启后 mutation 不丢失。
- Sync API 验证 ownership、Schema、revision 和幂等性。
- Server Persistence 保存账号所属记录及其服务端版本。
- Change Log 提供可按 cursor 重放的不可变变化序列。
- Inbox 在改变本地实体前 durable 保存远端输入。
- Remote Apply 执行 expected-local 检查，不调用 Backup Restore 伪装远端更新。
- Conflict Journal 保存无法自动合并的本地与远端候选。
- Derived Rebuild 只根据已经安全落地的事实重建派生数据。

## 4. Account Ownership

### 4.1 Server Ownership

云端实体的唯一归属边界是：

```text
(owner account, entity type, entity identity, conflict scope)
```

规则：

- `ownerId` 必须由服务端认证上下文确定。
- 服务端不得信任客户端 payload 提供的 `ownerId`、`userId` 或其他租户标识。
- 不同账号可以拥有相同的实体 ID；账号边界之外的裸 ID 不具有全局唯一性要求。
- 现有业务实体不得为了同步新增 `ownerId` 或 `userId` 字段。
- Ownership 属于服务端 wrapper 和本地 account-binding sidecar，不进入 Backup Entity。
- FavoriteLearningState 等关联实体只能引用同一 owner 下的目标实体。

### 4.2 Local Anonymous Data

本地数据可以在没有账号时创建，并保持未绑定状态。

首次登录不得自动把浏览器中的所有本地数据上传给当前账号。安全归属流程必须：

1. 建立经过认证的账号与云端设备注册。
2. 识别当前本地 workspace 是否尚未绑定账号。
3. 明确取得将本地数据加入该账号的用户意图。
4. 原样保留现有 stable ID。
5. 使用正常 create、unchanged 和 conflict 规则处理账号中已有数据。
6. 不因发生 identity conflict 而自动生成替代 ID。

Backup Restore 到本地的数据也不因当前存在登录 session 而自动获得云端 ownership。将恢复数据加入账号必须经过明确同步边界。

### 4.3 Logout and Account Switching

Logout：

- 停止当前账号的网络同步和认证访问。
- 不等同于删除本地数据、远端数据或账号。
- 不把已经绑定的本地数据重新标记为 anonymous。
- 不允许后续另一个账号自动继承或上传该 workspace。

在本地存储尚未按账号分区时，一个浏览器 profile 最多绑定一个云端账号。切换账号前必须采用明确的本地数据移除、导出或独立 profile 边界。未来若支持同 profile 多账号，本地实体、sidecar、outbox、inbox、cursor 和 conflict 必须全部按账号分区。

### 4.4 Device Identity

现有 QueryEvent 和 History Baseline 中的 `deviceId` 是历史 provenance fact：

- 必须原样保留。
- 不作为认证凭据。
- 不作为服务端可信设备身份。
- 不因 Restore、登录或设备注册而改写。

Cloud Sync 需要独立的 account-scoped device registration。云端设备身份用于认证辅助、mutation 来源、cursor acknowledgment、设备撤销和 tombstone 安全清理。它属于同步控制状态，不进入现有业务实体或 Backup v2。

## 5. Domain Payload and Sync Wrapper

Cloud Sync 必须保持业务 payload 与同步运行 metadata 分离。

服务端记录在概念上至少包含：

- entity type。
- entity identity。
- conflict scope。
- entity schema version。
- server revision。
- active / tombstone 等同步可见状态。
- canonical payload hash。
- server audit time。
- 经过对应 Schema 验证的 domain payload。

账号 ownership 可以存在于服务端数据库记录中，但不得成为客户端可修改的 domain payload 字段。

以下 metadata 必须保存在服务端 wrapper 或本地 sync sidecar，不得塞入现有 Backup Entity：

- owner / remote identity。
- server revision、remote revision 或 ETag。
- mutation ID、pending mutation 或 outbox 状态。
- cursor、last pulled position 或 acknowledgment。
- `syncStatus`、`dirty`、`lastSyncedAt`。
- conflict marker 或 remote conflict candidate。
- cloud device registration。
- retry、backoff 或 transport error 状态。

现有 Entity Schema 对 sync metadata 的禁止规则继续有效。同步层不得利用 unknown-field compatibility 把这些字段藏进业务 payload。

## 6. Server Revision

### 6.1 Revision Authority

服务端 revision 是 mutable sync record 的并发权威：

- Revision 由服务端分配并单调推进。
- Revision 的粒度是 `(owner, entity type, entity identity, conflict scope)`。
- 服务端内部可以使用单调整数；客户端必须把 wire revision 视为 opaque token。
- 客户端在 sidecar 中保存最后确认的 server revision 和 canonical payload hash。
- 相同 mutation 的幂等重放或 exact unchanged 不得无意义增加 revision。
- Immutable QueryEvent 的 same-ID exact replay 不生成新的事件或 revision 事实。

### 6.2 Client Time Is Not Revision

客户端 `updatedAt`、`timestamp`、Backup 创建时间或设备墙钟时间不能作为通用 LWW 权威，原因包括：

- 多设备时钟可能偏移、回拨或被修改。
- 离线 mutation 的到达时间不等于用户行为时间。
- 不同实体的时间字段具有不同业务语义。
- Preferences 当前没有 per-key 时间。
- QueryEvent timestamp 是 immutable event fact，不是更新版本。
- Article 的正文、生命周期、阅读状态和最近阅读时间不是同一 conflict scope。

Server audit time 只记录服务端接受或观察变化的时间，不能覆写合法 domain time，也不能自动决定重要内容冲突的胜者。

## 7. Change Cursor and Pull

### 7.1 Account-global Cursor

Cloud Sync 使用 per-account global change cursor，而不是默认为每个实体建立相互独立的 cursor。

规则：

- Cursor 对客户端 opaque。
- 服务端内部位置按账号单调推进。
- 六类实体共享同一已提交变化顺序。
- 每条 change 必须关联明确的 entity、scope、revision、operation/state 和该 revision 的 payload snapshot。
- Change Log 不得在 pull 时回查记录的最新 head 来替代历史 revision snapshot。
- 跨实体依赖仍须显式处理；global cursor 不保证一个 pull page 内父实体总早于依赖实体到达。

### 7.2 Durable Apply Boundary

客户端只有在以下条件满足后才能推进 applied cursor：

- 远端 change 已 durable 进入 inbox。
- Schema 和 capability 检查完成。
- Domain fact 已安全应用，或冲突已 durable 记录。
- 未支持的实体或 Schema 没有被静默跳过。
- 必要的派生重建已经成功，或留下可在重启后继续的 durable pending marker。

下载完成本身不等于 apply 完成。存储失败、关系未解析或冲突候选未保存时不得推进 cursor。

### 7.3 Cursor Loss and Full Resync

以下情况触发明确的 bootstrap / full resync：

- 新设备首次同步。
- 本地 cursor 丢失或损坏。
- 服务端 change log retention 已越过客户端 cursor。
- 协议或 capability 集变化需要重新建立实体基线。
- 本地 sidecar 与云端 revision 无法可靠协调。

Full resync 必须提供一致 snapshot 和 high-water cursor：

1. 客户端分页获取固定 high-water boundary 下的 snapshot。
2. 本地按正常 remote apply / conflict 规则处理，不整体覆盖本地数据。
3. Snapshot 完成后从 high-water cursor 继续增量 pull。

Snapshot 或增量 pull 中缺少某个实体不表示删除。只有显式 tombstone、unset、retraction 或其他正式生命周期事实可以传播删除。

## 8. Offline Mutation, Outbox, and Reconnect

### 8.1 Change Capture

所有参与同步的普通 UI mutation 最终必须经过能够记录同步意图的 Domain boundary。同步层不能长期依赖周期性完整 Backup Export 发现变化。

由于本地实体可能分布在不同持久化引擎，业务写入与全局 outbox 不能被假定为天然原子。实现必须具备：

- durable mutation intent。
- prepared / ready 或等价的 write-ahead 状态。
- last-synced canonical fingerprint。
- 启动时 reconciliation。
- 对 hard delete、unset 和 retraction 的预先 durable 记录。
- 多标签页和进程中断下的 compare-and-set 或等价并发保护。

### 8.2 Reconnect Sequence

一般重新联网流程为：

1. 恢复认证和 device registration 状态。
2. 从最后 applied cursor pull 到当前可用 head。
3. 安全 apply remote changes，记录 conflicts。
4. 对未冲突的 outbox mutations 执行 push。
5. 逐项处理 applied、unchanged、conflict、rejected 或 blocked 结果。
6. 再次 pull，收口 push 期间产生的新 change。

该顺序减少使用陈旧 base revision 上传的机会，但不能替代服务端 revision 检查。

### 8.3 Partial Failure

- Push batch 默认不是全局事务。
- 每个 mutation 的 record write、revision、change log 和 idempotency receipt 必须在服务端单项事务中原子提交。
- 已确认 applied 的 mutation 不因后续 mutation 失败而变回 failed。
- 未尝试项保持 pending / not-attempted。
- 网络在响应前中断时，客户端使用相同 mutation ID 重试整个未知集合。
- Pull apply 中断时，已落入 inbox 的 change 保持可重放；cursor 不越过未安全处理的 change。

## 9. Idempotent Push

每个本地 mutation 在首次进入 durable outbox 时获得 stable mutation ID。

长期规则：

- 幂等唯一作用域至少是 `(owner account, mutation ID)`。
- Mutation ID 不等于 entity ID。
- 重试、timeout、客户端重启或 batch 重组时必须复用原 mutation ID。
- 同一 mutation ID 与相同 canonical request 重放时，服务端返回第一次的确定结果。
- 同一 mutation ID 与不同 request 重用时，服务端必须 rejected，不能猜测调用方意图。
- 新增 mutable record 使用明确的无 base revision 状态。
- 更新、删除、恢复和 unset 携带调用方实际观察过的 base revision。
- stale base + different result 返回 conflict，而不是覆盖当前服务端记录。
- exact current payload 可以返回 unchanged，不制造无意义 change。
- 幂等 receipt 的保留期不得短于系统承诺支持的离线和重试窗口。
- Receipt 无法继续证明时返回 reconcile-required，不能盲目重新执行。

Batch ID 可以用于追踪一次网络请求，但不赋予 batch 全局事务语义。Favorite 与 FavoriteLearningState 等依赖不得只依靠数组顺序表达。

## 10. Conflict Principles

Cloud Sync 不采用全局 LWW。冲突按实体和 conflict scope 处理。

### 10.1 Three-way Boundary

Mutable record 的安全 remote apply 至少比较：

- base：本地 sidecar 记录的最后同步版本或 hash。
- local：当前 Repository 中的完整本地值。
- remote：收到的服务端 revision 与完整 payload。

基本判断：

- local 等于 base：本地未改变，可以按 Domain 规则应用 remote。
- remote 等于 base：远端未改变，保留 local 并确保存在 outbox mutation。
- local 等于 remote：两端已收敛，只更新 sidecar revision。
- 三者均不同：进入 conflict，不静默覆盖。

Conflict Journal 必须保存足以恢复或重新获取 remote candidate 的信息。重要正文、备注、生命周期或 deletion candidate 不能只记录一个错误码后丢失。

### 10.2 Shared Conflict Rules

- Same ID exact payload 是 unchanged / idempotent replay。
- Same ID 的 immutable fact 内容不同是 identity collision，必须 conflict。
- Different stable IDs 不因内容相同而自动去重。
- Delete 与并发 update 不得无提示复活或无提示丢弃 update。
- Tombstone 可以在可见状态上优先，但 losing update 必须保留为 conflict candidate。
- Restore 是基于当前 tombstone revision 的显式操作，不是普通 update 的副作用。
- Unsupported entity、Schema 或 operation 必须 rejected / blocked，不能静默忽略。
- Unknown 但合法的 domain extension 继续参与 exact equality、hash 和 conflict 判断。

Remote apply 必须使用同步专用 Domain 能力；Backup Restore 的 same-ID preserve 规则不能替代 remote revision apply。

## 11. Delete and Anti-resurrection

删除必须是显式且可同步的事实，集合缺失不是删除。

### 11.1 Tombstone-capable Entities

Article、Favorite 和 FavoriteLearningState 已具有 soft-delete / tombstone 基础。Cloud Sync 必须：

- 保留原 stable ID。
- 同步删除 revision。
- 不在其他设备上把 tombstone 当作不存在。
- 防止以旧 base revision 到达的 update 自动复活记录。
- 只允许显式 restore 撤销删除。

### 11.2 Tombstone Retention

V0.7 不要求 tombstone GC。未来永久清理必须同时满足：

- 所有仍被支持的账号设备已确认越过删除 change。
- 离线重试和恢复窗口已经结束。
- 服务端 change log、idempotency 和备份影响已明确。
- 不会因旧设备、旧 mutation 或 Restore 后的同步重新分配同一 ID。

在无法证明安全传播前不得自动永久删除同步相关 tombstone。

### 11.3 Non-tombstone Domains

Preferences 与 Query History 不能用集合缺失表达删除：

- Preferences 使用 explicit per-key unset marker 和 revision。
- Query History 使用 epoch、retraction 和 suppression 边界。

这些 lifecycle/control records 属于 Cloud Sync 域，不得偷加到现有 Backup Entity 的 unknown fields。

## 12. Six User Data Boundaries

Cloud Sync 的正式用户数据边界仍由六类现有 Backup v2 数据确定：

1. Articles。
2. Favorites。
3. FavoriteLearningStates。
4. Preferences。
5. QueryEvents。
6. HistoryBaselines。

这不表示六类实体已经同时满足真实双向同步条件。每个实体必须通过自己的 Gate B 检查。

### 12.1 Articles

Article 保持不依赖标题、正文或来源内容的 stable ID。

Cloud Sync 至少将以下内容视为不同 conflict scope：

- Article Content：正文内容及其 content revision。
- Article Metadata：标题、来源类型、弱来源关联、来源展示信息。
- Article Lifecycle：创建身份、软删除和显式恢复。
- Reading State：依附 Article 的最高进度和当前位置。
- Reading Activity：最近阅读活动，不修改正文 revision。

正式同步前必须解决：

- 移除或改变把 `(sourceType, sourceId)` 当成 user Article 唯一身份的约束。
- 明确 `sourceId` 只是弱来源关联，不阻止不同 Article ID 共存。
- 重要正文同 scope 并发差异不自动文本 merge。
- Delete-vs-edit 保持 Article 删除可见，同时保留 edit candidate。
- `createdAt` 不一致视为 identity/history conflict。
- 正文 revision 与 Reading position 的适用范围。

Reading Progress 依附 Article，不是第七个独立用户实体，也不需要加入新的 Backup collection。同步冲突边界可以独立于本地物理存储和 Backup 表达。

Reading 最小长期语义：

- `maxProgress` 与 `currentPosition` 分开。
- `maxProgress` 在同一 content revision 内通常单调取最大值。
- `currentPosition` 可以前进或后退，不能由最大值代替。
- `paragraphIndex` 或未来 anchor 必须关联明确的 content revision。
- 对旧 content revision 的位置不能直接应用到新正文。
- Stale reading update 不得降低已经确认的 maxProgress。
- Reading update 不得更新正文 revision或复活已删除 Article。
- 最近阅读时间不能决定正文冲突胜负。

可以使用 account-scoped cloud device checkpoint 避免不同设备整条覆盖当前位置，但该 checkpoint 是 Article 的依附同步状态，不改变 Reading 没有独立用户 identity 的原则。

### 12.2 Favorites

Favorite 适合作为第一批同步实体，因为它已经具备：

- 与内容无关的 stable ID。
- 清晰的实体字段边界。
- 独立内容快照。
- `createdAt`、`updatedAt`、`deletedAt` 生命周期。
- soft delete 与 restore。
- 不同 ID 相同内容仍独立存在的规则。
- same ID exact / conflict 的 Domain 基础。

V0.7 Favorite 可以采用 whole-record optimistic CAS：

- Exact replay 返回 unchanged。
- Same ID concurrent content change 返回 conflict。
- 不自动 union tags、拼接 note 或按客户端 `updatedAt` 整条 LWW。
- Delete-vs-update 与 delete-vs-restore 返回 conflict。
- 来源 Article 缺失或 tombstone 不导致 Favorite 内容快照丢失。

### 12.3 FavoriteLearningStates

FavoriteLearningState 适合作为 Favorite 之后的第一批同步实体，因为：

- `favoriteId` 是清晰稳定的 identity 和关联键。
- `mastered` 与 Favorite 内容解耦。
- 生命周期和 tombstone 独立。
- Favorite tombstone 仍是合法引用目标。

同步规则：

- `mastered:true` 与 `mastered:false` 是不同完整状态，不能 OR、AND 或把缺失解释为 false。
- Same favoriteId concurrent different mastered value 必须 conflict。
- Favorite delete 不级联删除 Learning State。
- Learning State delete 不修改 Favorite。
- Learning 先到而 Favorite 尚未 pull 到时进入 pending-reference；不丢弃、不自动创建 Favorite、不改成 false。
- Favorite 后续到达时重新解析。
- 完整 bootstrap 后仍 unresolved 时进入 quarantine / blocked integrity result。

### 12.4 Preferences

Preferences 以每个 preference key 为独立 identity 和 conflict scope，不使用整个 Preferences object revision。

正式同步规则：

- SetPreference 保存完整 JSON-safe value 和 base revision。
- UnsetPreference 使用显式 unset marker 和 base revision。
- 不同 key 可以独立收敛。
- Same key exact value 是 unchanged。
- Same key concurrent different value 是 conflict，不做 LWW。
- Set-vs-unset 是 conflict；unset 可以在可见状态上优先，但 set candidate 必须保留。
- Missing key 不是 unset、默认、删除或 reset。
- 不展开运行时默认值。
- Unknown 合法 preference key/value 原样保留。
- `speechVoice:null` 表示明确的自动选择偏好，与缺少 key 不同。
- `speechVoice` object 是 portable hint；目标设备没有该 voice 时只做 runtime fallback，不修改同步值。

正式同步前，所有普通 Preferences UI 写入必须进入统一的严格 Repository/change-capture 边界。宽松 writer 与后台 apply 并发写同一存储时，不得依赖最后一次 `setItem` 覆盖来收敛。

### 12.5 QueryEvents

QueryEvent 是 immutable event fact：

- Stable ID 原样保留。
- Different IDs 即使所有内容相同也表示不同查询事实。
- Same ID exact payload 是 idempotent replay。
- Same ID 任意内容不同是 identity collision / conflict。
- 不允许 update、field merge、LWW、改 timestamp 或改 provenance deviceId。

QueryEvent 的 create-only union 已适合增量上传，但当前 hard-delete/current-set 语义不足以安全支持多设备删除。正式双向同步必须与第 12.6 节的 Query History deletion control 一起开放。

### 12.6 HistoryBaselines and Query History Deletion

History Baseline 是无法还原为逐次 QueryEvent 的 legacy compatibility fact：

- ID 是 opaque stable identity。
- 不根据当前 records 重新计算历史 hash。
- Locator 保持 opaque，不根据 `record.word` normalize 或改写。
- Different IDs 即使 records 相同也独立存在。
- Migration State 不是 Baseline 字段，也不是云端用户实体。

正式同步前应把 Baseline 视为建立后 immutable 的 compatibility snapshot。删除历史不得继续依赖同 ID payload 的无 revision records 原地修改。

Query History 删除至少需要以下控制语义：

- `DeleteEvent`：抑制明确的 QueryEvent ID。
- `DeleteWord`：抑制因果边界之前相同 aggregation word 的 QueryEvents，并抑制 Baseline 中 `record.word` 相同的 records。
- `ClearHistory`：推进 account-scoped history epoch，使旧 epoch facts 不再参与查询历史。
- Baseline suppression：按实际 `(baselineId, locator)` 保存抑制结果，locator 仍不是 record identity，也不被重算。

每个 Query History mutation 的 sync wrapper 必须携带足以判断 history epoch 和调用方已观察 cursor 的因果信息。旧离线设备提交未观察到删除边界的 facts 时，不得仅因到达较晚就重新激活历史；它们应被 suppress、quarantine 或返回明确 stale-boundary conflict。设备观察新删除边界后产生的同 word 新查询仍然合法。

在任何远端 QueryEvent 或 History Baseline fact 写入本地前，客户端必须先安全处理尚未完成的本地 legacy migration boundary。Migration State 本身不上传。事实 apply 完成后，Vocab 只能由 QueryEvent + History Baseline 可见 facts 通过 Projector 重建。

## 13. Derived Data and Excluded Data

以下数据明确不进入 Cloud Sync：

- Vocab 聚合视图、查询次数缓存、搜索索引或其他派生视图。
- Dictionary、ECDICT entries、lemma mapping、dictionary metadata。
- Query History Migration State。
- 当前本地 DeviceId singleton；QueryEvent/Baseline 内已保存的 provenance value 仍属于其事实 payload。
- Backup reminder、backup dismiss、dictionary guide 或资源下载控制状态。
- UI navigation、`history.state`、当前选区、播放状态、临时任务或其他 runtime/session 状态。
- 未保存草稿或其他尚未成为正式用户实体的内存状态。
- Legacy Favorite map 及其 map-key identity。
- Backup Envelope metadata。
- Sync sidecar、outbox、inbox、cursor、retry 和 conflict runtime state。

Reading Progress 是 Article 依附的用户状态，属于 Article 同步边界，不属于排除项；但它不成为独立 Backup 或 sync identity。

Excluded data 不得因为传输方便被嵌入某个实体的 unknown fields。

## 14. Backup v2 and Cloud Sync

Backup v2 与 Cloud Sync 共享实体语义，但承担不同职责。

### 14.1 Backup v2 Responsibilities

Backup v2：

- 是用户主动生成或恢复的 portable snapshot。
- 不要求账号 ownership。
- 描述导出时包含的实体集合。
- 使用完整 Envelope 与各实体 Schema。
- 采用文件恢复和保守本地冲突语义。
- Missing collection/item 不传播删除。
- 不包含 revision、cursor、outbox 或设备注册。

### 14.2 Cloud Sync Responsibilities

Cloud Sync：

- 是经过认证的持续增量协议。
- 强制账号 ownership 和租户隔离。
- 传输 mutations 与 ordered changes，而不是完整 Backup Envelope。
- 使用 server revision、cursor、idempotency 和 retry。
- 处理离线、并发、删除传播和设备 acknowledgment。
- 使用 sync-specific remote apply 和 conflict journal。

### 14.3 Reusable Boundaries

Cloud Sync 应优先复用：

- Stable entity identity。
- Entity Schema Validator。
- 字段类型、生命周期和 JSON safety 规则。
- Unknown-field preservation。
- Repository 的严格读取、snapshot 和 compare-and-set 能力。
- Favorite、Learning、Article tombstone payload。
- QueryEvent immutable semantics。

Cloud Sync 不得复用为协议：

- 完整 Backup Envelope。
- `exportBackup()` 作为日常 change detector。
- 两轮 best-effort Backup snapshot 作为 server revision。
- Backup Restore dispatcher 作为 remote change apply。
- Backup current-set merge 作为删除传播。
- Backup 顶层 restore result 作为 Sync API result。

为了同步新增的 revision、owner、cursor、pending 或 conflict metadata 必须留在 wrapper/sidecar，不能反向污染 Backup Entity。

## 15. Entity Dependency and Apply Order

Global cursor 提供服务端提交顺序，但客户端仍需处理分页、重试和依赖乱序。

基本依赖：

- FavoriteLearningState 依赖相同 owner 下的 Favorite identity。
- Favorite tombstone 可以满足该 identity 关系。
- Article 删除不级联删除 Favorite、QueryEvent 或已保存快照。
- Preferences 与 Query History、Article、Favorite Learning 没有跨实体写入副作用。
- Query History facts apply 前必须完成本地 migration prerequisite。
- Query History facts apply 后才允许重建 Vocab。

无法立即满足关系的合法 change 应进入 durable pending-reference / quarantine，而不是自动创建依赖实体或静默丢弃。

## 16. Server and Client Safety Boundaries

任何真实个人数据进入云端前必须具备：

- 经过认证的 owner derivation。
- 强制 tenant isolation。
- 服务端 Schema 与 operation validation。
- Transport encryption 与 secret 管理。
- 请求体、批次、实体大小和速率限制。
- 日志与 telemetry 的个人内容最小化。
- Account export、device revoke 和 data deletion 边界。
- 服务端持久化 backup / restore 与灾难恢复计划。
- Feature flag 和 per-entity kill switch。

Shadow upload 仍然属于真实个人数据上传；即使不覆盖本地，也不能绕过用户同意、隐私和安全要求。

Telemetry 可以记录 count、hash、status、revision、cursor、延迟和错误码，不应记录正文、Favorite 内容、查询词或 Preferences value。

## 17. Staged Rollout

推荐按以下顺序开放能力：

1. Shared conformance fixtures 与本地 fake sync service。
2. Favorite upload-only shadow。
3. Favorite pull dry-run，仅 assessment，不写本地。
4. Favorite 内部账号真实 bidirectional apply。
5. FavoriteLearningState，验证 parent/child 乱序。
6. Preferences，在完成 per-key unset 和统一 writer 后开放。
7. Article / Reading，在完成 source identity 与 conflict scopes 后开放。
8. QueryEvent + History Baseline，在完成 deletion control 与 migration-aware apply 后开放。

从 shadow 进入真实 apply 至少要求：

- 重复 push 不增加事实或 revision。
- timeout 与 restart 重试不会重复写入。
- Cursor replay、bootstrap 和 incremental pull 收敛。
- Tenant isolation 测试不存在跨账号读取或写入。
- 不发生 silent overwrite。
- Conflict candidate 可恢复。
- Kill switch 能按实体停止 push / pull apply。
- Server persistence 与用户删除流程经过恢复验证。

## 18. Gate Definitions

### 18.1 Gate A — Cloud Foundation Development

Gate A 开放后，可以开始 provider-neutral 的开发环境、账号/认证骨架、数据库模型、Sync API、sidecar/outbox 和 fake integration。

Gate A 的最低条件：

- 核心用户数据实体边界已识别。
- Stable ID 与 local-first 原则已建立。
- Backup 与 Sync 职责已经分离。
- Ownership、revision、cursor、idempotency 和 metadata placement 有长期合同。
- 不再需要通过新增 Backup Entity 才能开始基础设施设计。
- 真实数据上传前的安全与隐私要求已经列为独立门禁。

Gate A 不表示任何实体已经可以真实双向同步，也不授权上传真实用户数据。

### 18.2 Gate B — Real Bidirectional Sync

Gate B 只在以下条件全部满足后开放：

- 认证 owner、tenant isolation、device registration 和 device revoke 已验证。
- Durable sidecar、outbox、inbox、cursor、conflict journal 和 crash recovery 已验证。
- Mutation idempotency、partial retry 和 server transaction boundary 已验证。
- Account-global opaque cursor、consistent bootstrap 和 cursor expiry 已验证。
- 所有参与真实同步的 UI 写入都进入 change-capture-aware Domain boundary。
- Article source identity、content/lifecycle/reading conflict scope 已收口。
- Reading maxProgress/currentPosition/content revision 边界已收口。
- Query History epoch/retraction/Baseline suppression 已收口。
- 远端 Query History apply 遵守 migration-before-facts 和 facts-before-projector 顺序。
- Preferences per-key revision、explicit unset 和 writer concurrency 已收口。
- Favorite/Learning pending-reference 和 tombstone 乱序已验证。
- Backup Restore 与 Sync apply 不会并发破坏同一本地数据。
- Schema/capability 不支持时不会静默忽略。
- Shadow telemetry、kill switch、隐私、账号删除和灾难恢复已通过上线门禁。

Gate B 可以按实体逐步开放，不要求六实体在同一天上线。未满足自己 Domain 条件的实体必须保持 disabled、shadow 或 upload-only，不得因为其他实体已安全而自动启用。

## 19. Long-term Invariants

以下不变量必须长期保持：

1. Entity ID 在本地、Backup、上传、下载、删除和恢复中保持不变。
2. Ownership 由认证上下文决定，不是 domain payload 字段。
3. Domain Entity 不包含 Sync runtime metadata。
4. Server revision 是并发权威；客户端时间不是通用 LWW。
5. Account change cursor 单调且对客户端 opaque。
6. Mutation 可以安全重复提交，同一幂等 key 不产生第二次事实。
7. Missing entity、collection 或 preference key 不表示删除。
8. 删除只通过正式 tombstone、unset、epoch 或 retraction 传播。
9. 旧设备不能以 stale revision 或 stale history boundary 无提示复活数据。
10. Same ID different immutable fact 永不覆盖。
11. Unknown 合法 domain fields 原样保留并参与 hash/conflict。
12. Unsupported entity、Schema 或 operation 永不静默忽略。
13. Cursor 不越过未安全 apply 或未 durable 保存的 conflict。
14. Query History migration 在任何远端 facts 本地写入前完成。
15. Vocab 始终由 QueryEvent + History Baseline 可见 facts 重建。
16. QueryEvent/Baseline provenance deviceId 不因 cloud device registration 改写。
17. Favorite 与 Learning 的生命周期独立，乱序不导致自动创建或数据丢弃。
18. Reading State 依附 Article，但不与正文共享一个不可分割的冲突范围。
19. Backup Restore 与 Cloud Sync Apply 是不同工作流，不能互相替代。
20. 网络或云服务不可用不阻止核心本地使用。

## 20. Out of Scope

本规范不设计或要求：

- 特定账号供应商、云平台、数据库或部署区域。
- 具体 HTTP endpoint、SDK、序列化格式或认证 UI。
- WebSocket、实时协同或 Service Worker background sync。
- CRDT、vector clock 或自动正文合并。
- 多区域 active-active。
- 每个实体独立微服务。
- 复杂 conflict resolution UI。
- Tombstone 自动 GC。
- Dictionary、Vocab、DeviceId singleton 或 Migration State 上云。
- Legacy Favorite 自动迁移。
- 对现有 Backup v2 Envelope 或 Entity Schema 的隐式修改。

未来实现可以在不改变本规范核心语义的前提下选择具体技术；任何会改变 ownership、identity、deletion、conflict、revision 或 cursor 意义的实现决定，必须先更新长期规范并经过兼容性审查。
