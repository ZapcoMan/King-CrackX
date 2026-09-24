# 安全审计功能说明

## 功能概述

安全审计是 King-CrackX 新增的核心功能，用于自动检测 Vue 应用中的安全风险，包括：

1. **敏感 API 检测** - 识别包含高危关键词的 API 端点
2. **路由权限分析** - 分析每个路由的权限配置
3. **未授权访问识别** - 找出缺少权限保护的路由
4. **Sourcemap 泄露检测** - 评估源码泄露风险
5. **Markdown 报告导出** - 生成专业的安全审计报告

## 使用方法

### 1. 执行安全审计

1. 打开 King-CrackX 扩展弹窗
2. 滚动到「安全审计」面板
3. 点击「开始审计」按钮
4. 等待审计完成（基于已有的路由分析和 API 提取结果）

### 2. 查看审计结果

审计完成后会展示：

- **风险等级摘要** - 整体风险评估（严重/高危/中危/低危/安全）
- **敏感 API 列表** - 按风险等级排序，显示匹配关键词和来源
- **未授权路由列表** - 缺少权限保护的路由及风险描述
- **安全建议** - 针对性的修复建议

### 3. 导出报告

- **导出 Markdown** - 下载完整的审计报告文件（.md 格式）
- **复制报告** - 将报告复制到剪贴板

## 检测规则

### 敏感 API 分类

| 分类 | 风险等级 | 关键词示例 |
|------|----------|------------|
| 管理接口 | 🔴 严重 | admin, manager, sys, system |
| 删除操作 | 🔴 严重 | delete, del, remove, destroy |
| 支付财务 | 🔴 严重 | pay, payment, order, bill |
| 系统配置 | 🔴 严重 | config, secret, password, env |
| 修改操作 | 🟠 高危 | update, edit, modify, change |
| 认证授权 | 🟠 高危 | auth, login, token, oauth |
| 用户数据 | 🟠 高危 | user, profile, account |
| 权限角色 | 🟠 高危 | role, permission, access |
| 文件操作 | 🟡 中危 | upload, download, file, export |
| 日志审计 | 🟡 中危 | log, audit, history, stats |
| 消息通知 | 🟢 低危 | notify, message, email, sms |
| 搜索查询 | 🟢 低危 | search, query, find, list |

### 路由权限检测

检测以下 meta 字段：

- **认证相关**: `requiresAuth`, `needLogin`, 任何包含 `auth` 的 key
- **角色控制**: `roles`, `role` (数组或字符串)
- **权限控制**: `permissions`, `perm` (数组或字符串)

### 风险评级逻辑

**未保护路由的风险等级**：
- 🔴 严重：管理相关路由（路径包含 admin/manage/sys）
- 🔴 严重：支付相关路由（路径包含 pay/order/bill）
- 🟠 高危：用户相关路由（路径包含 user/profile/account）
- 🟡 中危：其他未保护路由

**已保护路由的风险等级**：
- 🟢 低危：仅有基础认证，缺少细粒度权限
- ✅ 安全：权限配置完整（认证 + 角色/权限）

## 审计报告示例

```markdown
# King-CrackX 安全审计报告

**生成时间**: 2026-09-24 07:30:00
**目标页面**: https://example.com/admin

---

## 审计摘要

**整体风险等级**: 🔴 严重

| 指标 | 数量 |
|------|------|
| 敏感 API 总数 | 15 |
| 严重风险 | 5 |
| 高危 | 6 |
| 中危 | 3 |
| 低危 | 1 |
| 路由总数 | 20 |
| 已保护路由 | 15 |
| 未保护路由 | 5 |
| Sourcemap 泄露 | 2 |

---

## 敏感 API 检测结果

### 管理接口 (5 个)

| 路径 | 完整 URL | 风险等级 | 匹配关键词 | 来源 |
|------|----------|----------|------------|------|
| /api/admin/users | https://example.com/api/admin/users | 🔴 严重 | admin | 已调用 |

---

## 未授权访问路径

| 路径 | 路由名称 | 风险等级 | 风险描述 |
|------|----------|----------|----------|
| /admin/settings | AdminSettings | 🔴 严重 | 管理相关路由缺少权限保护 |

---

## 安全建议

- 🔴 发现高危敏感接口，建议立即检查这些接口的鉴权机制
- 🔴 发现 5 个未受保护的路由，建议添加路由守卫
- 🟡 生产环境不应暴露 Sourcemap，建议在构建时禁用或限制访问
```

## 技术实现

### 核心文件

- `src/utils/securityAudit.ts` - 审计算法和规则定义
- `src/utils/securityReport.ts` - Markdown 报告生成和导出
- `src/composables/useSecurityAudit.ts` - Vue 组合式函数
- `src/components/SecurityPanel.vue` - UI 面板组件

### 数据流

```
路由分析结果 ─┐
             ├→ performSecurityAudit() → SecurityAuditReport
API 提取结果 ─┘                              ↓
                                      generateSecurityReportMarkdown()
                                                      ↓
                                              导出/复制 Markdown 文件
```

### 依赖关系

安全审计功能依赖于：
- 路由分析结果（`vueAnalysisResult.allRoutes`）
- API 提取结果（`apiExtractResult.liveApis`, `staticApis`, `sourceMaps`）

**建议工作流程**：
1. 先执行「路由分析」
2. 再执行「API 提取」
3. 最后执行「安全审计」

## 注意事项

1. **前置条件**：需要先完成路由分析或 API 提取，否则审计结果不完整
2. **准确性**：基于静态分析和正则匹配，可能存在误报/漏报
3. **局限性**：无法检测后端鉴权逻辑，仅分析前端配置
4. **建议**：审计报告应作为安全审查的起点，而非唯一依据

## 未来规划

- [ ] 支持自定义敏感关键词规则（用户可添加自己的检测规则）
- [ ] 添加 API 请求测试功能（直接在弹窗中发送测试请求）
- [ ] 支持导出 PDF 格式报告（使用浏览器打印功能）
- [ ] 集成 OWASP Top 10 检测规则
- [ ] 批量测试未调用的高危 API 端点
- [ ] 支持导出 Burp Suite 格式的配置
- [ ] 添加 JWT/Token 分析功能
- [ ] 检测常见的 Vue 安全漏洞（如 v-html XSS）