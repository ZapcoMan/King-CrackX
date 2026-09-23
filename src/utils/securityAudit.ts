/**
 * 安全审计工具：敏感 API 检测、路由权限分析、未授权访问路径识别。
 *
 * 审计维度：
 *   1. 敏感 API 端点检测（admin/delete/update 等高危关键词）
 *   2. 路由权限配置分析（requiresAuth/roles/permissions 等 meta）
 *   3. 未授权访问路径识别（无守卫保护的路由）
 *   4. Sourcemap 泄露风险评估
 */

/** 敏感关键词分类 */
export interface SensitiveKeywordCategory {
    category: string;
    keywords: string[];
    riskLevel: 'critical' | 'high' | 'medium' | 'low';
    description: string;
}

/** 敏感 API 检测结果 */
export interface SensitiveApiDetection {
    path: string;
    fullUrl: string;
    category: string;
    matchedKeyword: string;
    riskLevel: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    source: 'live' | 'static';
}

/** 路由权限分析结果 */
export interface RoutePermissionAnalysis {
    path: string;
    name?: string;
    hasAuth: boolean;
    authKeys: string[];
    hasRoles: boolean;
    roles?: string[];
    hasPermissions: boolean;
    permissions?: string[];
    isProtected: boolean;
    riskLevel: 'critical' | 'high' | 'medium' | 'low' | 'safe';
    riskDescription: string;
}

/** Sourcemap 泄露风险 */
export interface SourceMapRisk {
    mapUrl: string;
    scriptUrl: string;
    riskLevel: 'high' | 'medium' | 'low';
    description: string;
}

/** 完整审计报告 */
export interface SecurityAuditReport {
    timestamp: number;
    pageUrl: string;
    summary: AuditSummary;
    sensitiveApis: SensitiveApiDetection[];
    routePermissions: RoutePermissionAnalysis[];
    unauthorizedRoutes: RoutePermissionAnalysis[];
    sourceMapRisks: SourceMapRisk[];
    recommendations: string[];
}

/** 审计摘要 */
export interface AuditSummary {
    totalApis: number;
    sensitiveApiCount: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    totalRoutes: number;
    protectedRoutes: number;
    unprotectedRoutes: number;
    sourceMapLeakCount: number;
    overallRisk: 'critical' | 'high' | 'medium' | 'low' | 'safe';
}

/** 敏感关键词分类定义 */
const SENSITIVE_CATEGORIES: SensitiveKeywordCategory[] = [
    {
        category: '管理接口',
        keywords: ['admin', 'manager', 'mgr', 'sys', 'system', 'manage', 'superadmin', 'administrator'],
        riskLevel: 'critical',
        description: '管理后台接口，可能包含敏感操作权限'
    },
    {
        category: '删除操作',
        keywords: ['delete', 'del', 'remove', 'destroy', 'drop', 'truncate'],
        riskLevel: 'critical',
        description: '数据删除接口，可能导致数据丢失'
    },
    {
        category: '修改操作',
        keywords: ['update', 'edit', 'modify', 'change', 'alter', 'patch', 'put'],
        riskLevel: 'high',
        description: '数据修改接口，可能被用于篡改数据'
    },
    {
        category: '认证授权',
        keywords: ['auth', 'login', 'logout', 'register', 'signup', 'signin', 'token', 'oauth', 'sso', 'captcha', 'sms', 'verify'],
        riskLevel: 'high',
        description: '认证授权接口，可能被用于暴力破解或越权'
    },
    {
        category: '用户数据',
        keywords: ['user', 'users', 'profile', 'account', 'member', 'customer', 'employee', 'staff'],
        riskLevel: 'high',
        description: '用户数据接口，可能泄露个人信息'
    },
    {
        category: '支付财务',
        keywords: ['pay', 'payment', 'order', 'bill', 'invoice', 'refund', 'transaction', 'finance', 'money', 'price', 'cost'],
        riskLevel: 'critical',
        description: '支付财务接口，涉及资金安全'
    },
    {
        category: '文件操作',
        keywords: ['upload', 'download', 'file', 'files', 'image', 'images', 'avatar', 'attachment', 'export', 'import'],
        riskLevel: 'medium',
        description: '文件操作接口，可能被用于文件上传漏洞'
    },
    {
        category: '系统配置',
        keywords: ['config', 'setting', 'settings', 'env', 'environment', 'secret', 'key', 'password', 'pwd'],
        riskLevel: 'critical',
        description: '系统配置接口，可能泄露敏感配置信息'
    },
    {
        category: '日志审计',
        keywords: ['log', 'logs', 'audit', 'trace', 'history', 'record', 'stat', 'stats', 'analytics'],
        riskLevel: 'medium',
        description: '日志审计接口，可能包含敏感操作记录'
    },
    {
        category: '权限角色',
        keywords: ['role', 'roles', 'perm', 'permission', 'permissions', 'access', 'privilege', 'authority'],
        riskLevel: 'high',
        description: '权限角色接口，可能被用于提权攻击'
    },
    {
        category: '消息通知',
        keywords: ['notify', 'notification', 'message', 'mail', 'email', 'sms', 'push', 'alert'],
        riskLevel: 'low',
        description: '消息通知接口，可能被用于垃圾信息发送'
    },
    {
        category: '搜索查询',
        keywords: ['search', 'query', 'find', 'list', 'detail', 'info', 'get', 'fetch', 'retrieve'],
        riskLevel: 'low',
        description: '搜索查询接口，可能被用于信息收集'
    }
];

/**
 * 检测 API 路径是否包含敏感关键词。
 *
 * @param path - API 路径
 * @param fullUrl - 完整 URL
 * @param source - 来源（live/static）
 * @returns 检测结果数组（可能匹配多个分类）
 */
export function detectSensitiveApi(
    path: string,
    fullUrl: string,
    source: 'live' | 'static'
): SensitiveApiDetection[] {
    const results: SensitiveApiDetection[] = [];
    const lowerPath = path.toLowerCase();

    for (const category of SENSITIVE_CATEGORIES) {
        for (const keyword of category.keywords) {
            if (lowerPath.includes(keyword)) {
                results.push({
                    path,
                    fullUrl,
                    category: category.category,
                    matchedKeyword: keyword,
                    riskLevel: category.riskLevel,
                    description: category.description,
                    source
                });
                break;
            }
        }
    }

    return results;
}

/**
 * 分析单条路由的权限配置。
 *
 * @param route - 路由条目
 * @returns 权限分析结果
 */
export function analyzeRoutePermission(route: RouteEntry): RoutePermissionAnalysis {
    const meta = route.meta || {};
    const authKeys: string[] = [];
    let hasRoles = false;
    let roles: string[] | undefined;
    let hasPermissions = false;
    let permissions: string[] | undefined;

    for (const [key, value] of Object.entries(meta)) {
        const lowerKey = key.toLowerCase();

        if (lowerKey.includes('auth') || lowerKey === 'requiresauth' || lowerKey === 'needlogin') {
            authKeys.push(key);
        }

        if (lowerKey.includes('role')) {
            hasRoles = true;
            if (Array.isArray(value)) {
                roles = value.map(String);
            } else if (typeof value === 'string') {
                roles = [value];
            }
        }

        if (lowerKey.includes('perm')) {
            hasPermissions = true;
            if (Array.isArray(value)) {
                permissions = value.map(String);
            } else if (typeof value === 'string') {
                permissions = [value];
            }
        }
    }

    const hasAuth = authKeys.length > 0;
    const isProtected = hasAuth || hasRoles || hasPermissions;

    let riskLevel: RoutePermissionAnalysis['riskLevel'];
    let riskDescription: string;

    if (!isProtected) {
        const pathLower = (route.path || '').toLowerCase();
        if (pathLower.includes('admin') || pathLower.includes('manage') || pathLower.includes('sys')) {
            riskLevel = 'critical';
            riskDescription = '管理相关路由缺少权限保护';
        } else if (pathLower.includes('user') || pathLower.includes('profile') || pathLower.includes('account')) {
            riskLevel = 'high';
            riskDescription = '用户相关路由缺少权限保护';
        } else if (pathLower.includes('pay') || pathLower.includes('order') || pathLower.includes('bill')) {
            riskLevel = 'critical';
            riskDescription = '支付相关路由缺少权限保护';
        } else {
            riskLevel = 'medium';
            riskDescription = '路由缺少权限保护，可能存在未授权访问';
        }
    } else if (hasAuth && !hasRoles && !hasPermissions) {
        riskLevel = 'low';
        riskDescription = '仅有基础认证保护，缺少细粒度权限控制';
    } else {
        riskLevel = 'safe';
        riskDescription = '路由权限配置完整';
    }

    return {
        path: route.path || '',
        name: route.name,
        hasAuth,
        authKeys,
        hasRoles,
        roles,
        hasPermissions,
        permissions,
        isProtected,
        riskLevel,
        riskDescription
    };
}

/**
 * 分析 Sourcemap 泄露风险。
 *
 * @param sourceMaps - 检测到的 sourcemap 列表
 * @returns 风险评估列表
 */
export function analyzeSourceMapRisks(sourceMaps: SourceMapLeak[]): SourceMapRisk[] {
    return sourceMaps.map(map => {
        const mapUrlLower = map.mapUrl.toLowerCase();
        let riskLevel: SourceMapRisk['riskLevel'] = 'medium';
        let description = 'Sourcemap 泄露可还原源码';

        if (mapUrlLower.includes('admin') || mapUrlLower.includes('config') || mapUrlLower.includes('secret')) {
            riskLevel = 'high';
            description = '敏感模块的 Sourcemap 泄露，可能暴露关键业务逻辑';
        }

        if (mapUrlLower.includes('.env') || mapUrlLower.includes('secret') || mapUrlLower.includes('key')) {
            riskLevel = 'high';
            description = '可能包含敏感配置信息的 Sourcemap 泄露';
        }

        return {
            mapUrl: map.mapUrl,
            scriptUrl: map.scriptUrl,
            riskLevel,
            description
        };
    });
}

/**
 * 生成审计摘要。
 *
 * @param sensitiveApis - 敏感 API 列表
 * @param routePermissions - 路由权限分析列表
 * @param sourceMapRisks - Sourcemap 风险列表
 * @returns 审计摘要
 */
export function generateAuditSummary(
    sensitiveApis: SensitiveApiDetection[],
    routePermissions: RoutePermissionAnalysis[],
    sourceMapRisks: SourceMapRisk[]
): AuditSummary {
    const criticalCount = sensitiveApis.filter(a => a.riskLevel === 'critical').length;
    const highCount = sensitiveApis.filter(a => a.riskLevel === 'high').length;
    const mediumCount = sensitiveApis.filter(a => a.riskLevel === 'medium').length;
    const lowCount = sensitiveApis.filter(a => a.riskLevel === 'low').length;

    const protectedRoutes = routePermissions.filter(r => r.isProtected).length;
    const unprotectedRoutes = routePermissions.filter(r => !r.isProtected).length;

    let overallRisk: AuditSummary['overallRisk'];
    if (criticalCount > 0 || unprotectedRoutes > 5) {
        overallRisk = 'critical';
    } else if (highCount > 3 || unprotectedRoutes > 2) {
        overallRisk = 'high';
    } else if (mediumCount > 5 || unprotectedRoutes > 0) {
        overallRisk = 'medium';
    } else if (lowCount > 0) {
        overallRisk = 'low';
    } else {
        overallRisk = 'safe';
    }

    return {
        totalApis: sensitiveApis.length,
        sensitiveApiCount: sensitiveApis.length,
        criticalCount,
        highCount,
        mediumCount,
        lowCount,
        totalRoutes: routePermissions.length,
        protectedRoutes,
        unprotectedRoutes,
        sourceMapLeakCount: sourceMapRisks.length,
        overallRisk
    };
}

/**
 * 生成安全建议。
 *
 * @param report - 审计报告
 * @returns 建议列表
 */
export function generateRecommendations(report: SecurityAuditReport): string[] {
    const recommendations: string[] = [];

    if (report.summary.criticalCount > 0) {
        recommendations.push('🔴 发现高危敏感接口，建议立即检查这些接口的鉴权机制');
    }

    if (report.summary.unprotectedRoutes > 0) {
        recommendations.push(`🔴 发现 ${report.summary.unprotectedRoutes} 个未受保护的路由，建议添加路由守卫`);
    }

    if (report.summary.sourceMapLeakCount > 0) {
        recommendations.push('🟡 生产环境不应暴露 Sourcemap，建议在构建时禁用或限制访问');
    }

    const adminRoutes = report.routePermissions.filter(
        r => r.path.toLowerCase().includes('admin') && !r.isProtected
    );
    if (adminRoutes.length > 0) {
        recommendations.push('🔴 管理路由缺少权限保护，这是严重的安全隐患');
    }

    const sensitiveUncalled = report.sensitiveApis.filter(
        api => api.source === 'static' && api.riskLevel === 'critical'
    );
    if (sensitiveUncalled.length > 0) {
        recommendations.push('🟡 发现未调用的高危接口，建议重点测试这些端点的鉴权逻辑');
    }

    if (recommendations.length === 0) {
        recommendations.push('✅ 当前未发现明显安全风险，但仍需定期审查');
    }

    return recommendations;
}

/**
 * 执行完整的安全审计。
 *
 * @param params - 审计参数
 * @returns 审计报告
 */
export function performSecurityAudit(params: {
    pageUrl: string;
    liveApis: LiveApiItem[];
    staticApis: StaticApiItem[];
    routes: RouteEntry[];
    sourceMaps: SourceMapLeak[];
}): SecurityAuditReport {
    const { pageUrl, liveApis, staticApis, routes, sourceMaps } = params;

    const sensitiveApis: SensitiveApiDetection[] = [];

    liveApis.forEach(api => {
        const detections = detectSensitiveApi(api.url || api.path, api.url || api.path, 'live');
        sensitiveApis.push(...detections);
    });

    staticApis.forEach(api => {
        const detections = detectSensitiveApi(api.path, api.fullUrl || api.path, 'static');
        sensitiveApis.push(...detections);
    });

    const routePermissions = routes.map(analyzeRoutePermission);
    const unauthorizedRoutes = routePermissions.filter(r => !r.isProtected);
    const sourceMapRisks = analyzeSourceMapRisks(sourceMaps);
    const summary = generateAuditSummary(sensitiveApis, routePermissions, sourceMapRisks);

    const report: SecurityAuditReport = {
        timestamp: Date.now(),
        pageUrl,
        summary,
        sensitiveApis,
        routePermissions,
        unauthorizedRoutes,
        sourceMapRisks,
        recommendations: []
    };

    report.recommendations = generateRecommendations(report);

    return report;
}

/**
 * 风险等级排序权重。
 */
export const RISK_LEVEL_WEIGHT: Record<string, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
    safe: 0
};

/**
 * 按风险等级排序敏感 API。
 */
export function sortSensitiveApisByRisk(apis: SensitiveApiDetection[]): SensitiveApiDetection[] {
    return [...apis].sort((a, b) => RISK_LEVEL_WEIGHT[b.riskLevel] - RISK_LEVEL_WEIGHT[a.riskLevel]);
}

/**
 * 按风险等级排序路由。
 */
export function sortRoutesByRisk(routes: RoutePermissionAnalysis[]): RoutePermissionAnalysis[] {
    return [...routes].sort((a, b) => RISK_LEVEL_WEIGHT[b.riskLevel] - RISK_LEVEL_WEIGHT[a.riskLevel]);
}