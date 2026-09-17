# Agent Note：浏览器会话管理

Status: implemented

[English](2026-09-17-managed-browser-sessions.md) | 中文

## 问题

通过反向代理访问的单用户 Web 部署需要列出浏览器会话、撤销被复制的凭据，并在不重启 agent 的情况下轮换登录链接。无状态 cookie 无法标识或撤销单个会话。

## 决策

Connection 提供显式启用的 `browserSessionManagement`，默认仍为 false。管理器在独立的 `client-connection/managed-browser-sessions` 凭据记录中保存签名密钥、密钥标识和有界会话列表。v2 cookie 包含随机会话标识和 HMAC；认证还要求存在有效且 authority 匹配的服务端记录。启用管理模式会拒绝旧 cookie，需要重新交换启动令牌。`secureCookie` 为 HTTPS 部署添加 Secure；代理必须保留 Host。

登录和修改先串行提交持久化写入，再发布 cookie 或撤销结果。已认证的 JSON 修改必须携带完全匹配同源的 Origin，包括协议。仅当 Host 声明管理模式时，settings-general 插件才添加本地化的“登录安全”页面。Connection 的精确 Fetch 路由负责 cookie 响应；生成的 RPC 无法设置浏览器 cookie。列表和定向操作按 authority 隔离。全部退出和签名密钥轮换有意撤销所有 authority，并同时轮换进程启动令牌，返回一个恢复链接。当前 cookie 轮换仅替换调用者的会话；其他浏览器被撤销后需要重新登录。

Gateway 在撤销时、收发流消息前以及现有心跳中重新验证已升级连接。已经分发的一元操作不会回滚。最近活动包含心跳，在内存中追踪，并在后续会话修改时保存检查点。会话采用绝对过期时间，由 `maxBrowserSessions` 限制数量，默认 100。达到容量后，令牌登录会被拒绝，直到有会话过期或被撤销。

## 验证

所属包测试覆盖单设备撤销、重启持久性、写入失败、并发登录提交、authority 隔离、Origin 检查、过期、容量以及独立的 cookie/令牌/密钥轮换。真实 Loader HTTP 组合覆盖令牌交换、已认证管理、撤销后的首页/API 访问以及路由释放。Web 场景通过显式 overlay 启动随附插件，检查本地化控件、改名、实时连接断开、cookie 更新，以及全局轮换后的可用恢复链接。

## 考虑过的替代方案

纯外部管理无法撤销由 Connection 私有验证器持有的 cookie。实现扩展现有 Connection 和设置插件，保留显式启用配置，避免引入新的包依赖图。暂缓分布式会话存储：管理模式只支持每个 Harness home 一个活动 Web 进程。多个并发所有者需要共享失效通知与事务协调。旧密钥宽限期也暂缓；全局密钥轮换立即失效。

## 影响

每个已认证浏览器仍具有完整 Host API 的管理员权限。设备名称是用户标签，不是硬件身份；复制的 cookie 共享同一会话。普通退出或定向撤销不会撤销已知的启动令牌，因此令牌可能泄露时还需轮换启动链接。如果轮换响应丢失，重启服务会打印新的启动链接。旧记录保持独立；主动关闭管理模式会恢复旧认证行为。

此显式部署模式部分取代[浏览器启动令牌认证](../architecture/2026-08-24-browser-token-authentication.zh.md)中暂缓 logout 和反代支持的决定。该记录仍对默认无状态模式有效；没有记录需要归档。
