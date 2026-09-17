# 浏览器登录安全

[English](browser-security.md) | 中文

## 启用会话管理

[HTTPS overlay](../../../apps/cli/config/examples/browser-security.patch.yml)可启用可撤销的浏览器会话。每个 Harness home 运行一个 Web 进程，前面使用保留 Host 并支持 WebSocket 升级的 HTTPS 反向代理。在仓库根目录通过 overlay 和实际域名启动 Web profile：

```sh
pnpm dsh --profile web --patch apps/cli/config/examples/browser-security.patch.yml --no-open --trusted-host dsh.example.com
```

overlay 替换 Connection 行的配置，并保留 Web runtime 提供的可信主机。它启用 Secure cookie、30 天绝对有效期和最多 100 个活动会话。已有无状态 cookie 需要通过启动链接重新登录；其他应用数据不变。管理凭据通过正常凭据提供方保存，应纳入私密备份。

## 管理设备

打开“设置 → 登录安全”。没有已有 cookie 的浏览器登录时会创建一个设备会话。可通过改名识别设备；浏览器描述不代表经过验证的硬件身份。复制的 cookie 共享同一会话，撤销时一起失效。刷新列表可查看包含连接心跳的活动时间。

“退出此设备”撤销单台设备。“退出其他设备”保留当前 authority 的当前会话。“更新当前 Cookie”仅替换当前 cookie，不能远程给其他浏览器安装新 cookie。被撤销的 Gateway 连接立即断开；已经分发的一元操作不会回滚。

“轮换启动链接”使旧启动 URL 失效，同时保留已有会话。“全部退出并轮换链接”撤销所有 authority 的会话。“轮换全局签名密钥”还会替换签名密钥，旧密钥没有宽限期。这两种全局操作也会退出当前浏览器，并显示新的私密登录链接。离开页面前请保存链接。

## 恢复与更新

如果轮换响应丢失，或者没有浏览器保持登录，可重启 Web 服务并使用新打印的启动链接。不要公开包含该链接的日志。普通重启保留有效的管理会话，但会轮换启动令牌。关闭管理模式会恢复独立的旧认证模式，因此不能用来撤销会话。

将自定义改动提交到自己的 fork。获取官方 upstream，将其默认分支合并到自定义分支，处理冲突，并在推送前运行认证和浏览器回归测试。部署时从自己的 fork 拉取，按锁文件安装依赖、构建，仅在构建成功后重启。保留前一提交和私密凭据备份以便回滚；回滚到无状态认证会改变被接受的 cookie。
