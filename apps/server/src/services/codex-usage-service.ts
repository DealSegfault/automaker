import {
  findCodexCliPath,
  spawnProcess,
  getCodexAuthPath,
  systemPathExists,
  systemPathReadFile,
} from '@automaker/platform';
import { createLogger } from '@automaker/utils';

const logger = createLogger('CodexUsage');

export interface CodexRateLimitWindow {
  limit: number;
  used: number;
  remaining: number;
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface CodexCreditsSnapshot {
  balance?: string;
  unlimited?: boolean;
  hasCredits?: boolean;
}

export type CodexPlanType = 'free' | 'plus' | 'pro' | 'team' | 'enterprise' | 'edu' | 'unknown';

export interface CodexUsageData {
  rateLimits: {
    primary?: CodexRateLimitWindow;
    secondary?: CodexRateLimitWindow;
    credits?: CodexCreditsSnapshot;
    planType?: CodexPlanType;
  } | null;
  lastUpdated: string;
}

/**
 * Codex Usage Service
 *
 * Attempts to fetch usage data from Codex CLI and OpenAI API.
 * Codex CLI doesn't provide a direct usage command, but we can:
 * 1. Parse usage info from error responses (rate limit errors contain plan info)
 * 2. Check for OpenAI API usage if API key is available
 */
export class CodexUsageService {
  private cachedCliPath: string | null = null;

  /**
   * Check if Codex CLI is available on the system
   */
  async isAvailable(): Promise<boolean> {
    this.cachedCliPath = await findCodexCliPath();
    return Boolean(this.cachedCliPath);
  }

  /**
   * Attempt to fetch usage data
   *
   * Tries multiple approaches:
   * 1. Always try to get plan type from auth file first (authoritative source)
   * 2. Check for OpenAI API key in environment for API usage
   * 3. Make a test request to capture rate limit headers from CLI
   * 4. Combine results from auth file and CLI
   */
  async fetchUsageData(): Promise<CodexUsageData> {
    const cliPath = this.cachedCliPath || (await findCodexCliPath());

    if (!cliPath) {
      throw new Error('Codex CLI not found. Please install it with: npm install -g @openai/codex');
    }

    // Always try to get plan type from auth file first - this is the authoritative source
    const authPlanType = await this.getPlanTypeFromAuthFile();

    // Check if user has an API key that we can use
    const hasApiKey = !!process.env.OPENAI_API_KEY;

    if (hasApiKey) {
      // Try to get usage from OpenAI API
      const openaiUsage = await this.fetchOpenAIUsage();
      if (openaiUsage) {
        // Merge with auth file plan type if available
        if (authPlanType && openaiUsage.rateLimits) {
          openaiUsage.rateLimits.planType = authPlanType;
        }
        return openaiUsage;
      }
    }

    // Try to get usage from Codex CLI by making a simple request
    const codexUsage = await this.fetchCodexUsage(cliPath, authPlanType);
    if (codexUsage) {
      return codexUsage;
    }

    // Fallback: try to parse full usage from auth file
    const authUsage = await this.fetchFromAuthFile();
    if (authUsage) {
      return authUsage;
    }

    // If all else fails, return a message with helpful information
    throw new Error(
      'Codex usage statistics require additional configuration. ' +
        'To enable usage tracking:\n\n' +
        '1. Set your OpenAI API key in the environment:\n' +
        '   export OPENAI_API_KEY=sk-...\n\n' +
        '2. Or check your usage at:\n' +
        '   https://platform.openai.com/usage\n\n' +
        'Note: If using Codex CLI with ChatGPT OAuth authentication, ' +
        'usage data must be queried through your OpenAI account.'
    );
  }

  /**
   * Extract plan type from auth file JWT token
   * Returns the actual plan type or 'unknown' if not available
   */
  private async getPlanTypeFromAuthFile(): Promise<CodexPlanType> {
    try {
      const authFilePath = getCodexAuthPath();
      const exists = await systemPathExists(authFilePath);

      if (!exists) {
        return 'unknown';
      }

      const authContent = await systemPathReadFile(authFilePath);
      const authData = JSON.parse(authContent);

      if (!authData.tokens?.id_token) {
        return 'unknown';
      }

      const claims = this.parseJwt(authData.tokens.id_token);
      if (!claims) {
        return 'unknown';
      }

      // Extract plan type from nested OpenAI auth object with type validation
      const openaiAuthClaim = claims['https://api.openai.com/auth'];

      let accountType: string | undefined;
      let isSubscriptionExpired = false;

      if (
        openaiAuthClaim &&
        typeof openaiAuthClaim === 'object' &&
        !Array.isArray(openaiAuthClaim)
      ) {
        const openaiAuth = openaiAuthClaim as Record<string, unknown>;

        if (typeof openaiAuth.chatgpt_plan_type === 'string') {
          accountType = openaiAuth.chatgpt_plan_type;
        }

        // Check if subscription has expired
        if (typeof openaiAuth.chatgpt_subscription_active_until === 'string') {
          const expiryDate = new Date(openaiAuth.chatgpt_subscription_active_until);
          if (!isNaN(expiryDate.getTime())) {
            isSubscriptionExpired = expiryDate < new Date();
          }
        }
      } else {
        // Fallback: try top-level claim names
        const possibleClaimNames = [
          'https://chatgpt.com/account_type',
          'account_type',
          'plan',
          'plan_type',
        ];

        for (const claimName of possibleClaimNames) {
          const claimValue = claims[claimName];
          if (claimValue && typeof claimValue === 'string') {
            accountType = claimValue;
            break;
          }
        }
      }

      // If subscription is expired, treat as free plan
      if (isSubscriptionExpired && accountType && accountType !== 'free') {
        logger.info(`Subscription expired, using "free" instead of "${accountType}"`);
        accountType = 'free';
      }

      if (accountType) {
        const normalizedType = accountType.toLowerCase();
        if (['free', 'plus', 'pro', 'team', 'enterprise', 'edu'].includes(normalizedType)) {
          return normalizedType as CodexPlanType;
        }
      }
    } catch (error) {
      logger.error('Failed to get plan type from auth file:', error);
    }

    return 'unknown';
  }

  /**
   * Try to fetch usage from OpenAI API using the API key
   */
  private async fetchOpenAIUsage(): Promise<CodexUsageData | null> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return null;
    }

    try {
      const endTime = Math.floor(Date.now() / 1000);
      const startTime = endTime - 7 * 24 * 60 * 60; // Last 7 days

      const response = await fetch(
        `https://api.openai.com/v1/organization/usage/completions?start_time=${startTime}&end_time=${endTime}&limit=1`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (response.ok) {
        const data = await response.json();
        return this.parseOpenAIUsage(data);
      }
    } catch (error) {
      logger.error('Failed to fetch from OpenAI API:', error);
    }

    return null;
  }

  /**
   * Parse OpenAI usage API response
   */
  private parseOpenAIUsage(data: any): CodexUsageData {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    if (data.data && Array.isArray(data.data)) {
      for (const bucket of data.data) {
        if (bucket.results && Array.isArray(bucket.results)) {
          for (const result of bucket.results) {
            totalInputTokens += result.input_tokens || 0;
            totalOutputTokens += result.output_tokens || 0;
          }
        }
      }
    }

    return {
      rateLimits: {
        planType: 'unknown',
        credits: {
          hasCredits: true,
        },
      },
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Try to fetch usage by making a test request to Codex CLI
   * and parsing rate limit information from the response
   */
  private async fetchCodexUsage(
    cliPath: string,
    authPlanType: CodexPlanType
  ): Promise<CodexUsageData | null> {
    try {
      // Make a simple request to trigger rate limit info if at limit
      const result = await spawnProcess({
        command: cliPath,
        args: ['exec', '--', 'echo', 'test'],
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERM: 'dumb',
        },
        timeout: 10000,
      });

      // Parse the output for rate limit information
      const combinedOutput = (result.stdout + result.stderr).toLowerCase();

      // Check if we got a rate limit error
      const rateLimitMatch = combinedOutput.match(
        /usage_limit_reached.*?"plan_type":"([^"]+)".*?"resets_at":(\d+).*?"resets_in_seconds":(\d+)/
      );

      if (rateLimitMatch) {
        // Rate limit error contains the plan type - use that as it's the most authoritative
        const planType = rateLimitMatch[1] as CodexPlanType;
        const resetsAt = parseInt(rateLimitMatch[2], 10);
        const resetsInSeconds = parseInt(rateLimitMatch[3], 10);

        logger.info(
          `Rate limit hit - plan: ${planType}, resets in ${Math.ceil(resetsInSeconds / 60)} mins`
        );

        return {
          rateLimits: {
            planType,
            primary: {
              limit: 0,
              used: 0,
              remaining: 0,
              usedPercent: 100,
              windowDurationMins: Math.ceil(resetsInSeconds / 60),
              resetsAt,
            },
          },
          lastUpdated: new Date().toISOString(),
        };
      }

      // No rate limit error - use the plan type from auth file
      const isFreePlan = authPlanType === 'free';

      return {
        rateLimits: {
          planType: authPlanType,
          credits: {
            hasCredits: true,
            unlimited: !isFreePlan && authPlanType !== 'unknown',
          },
        },
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Failed to fetch from Codex CLI:', error);
    }

    return null;
  }

  /**
   * Try to extract usage info from the Codex auth file
   * Reuses getPlanTypeFromAuthFile to avoid code duplication
   */
  private async fetchFromAuthFile(): Promise<CodexUsageData | null> {
    try {
      const planType = await this.getPlanTypeFromAuthFile();

      if (planType === 'unknown') {
        return null;
      }

      const isFreePlan = planType === 'free';

      return {
        rateLimits: {
          planType,
          credits: {
            hasCredits: true,
            unlimited: !isFreePlan,
          },
        },
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Failed to parse auth file:', error);
    }

    return null;
  }

  /**
   * Parse JWT token to extract claims
   */
  private parseJwt(token: string): any {
    try {
      const parts = token.split('.');

      if (parts.length !== 3) {
        return null;
      }

      const base64Url = parts[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');

      // Use Buffer for Node.js environment instead of atob
      let jsonPayload: string;
      if (typeof Buffer !== 'undefined') {
        jsonPayload = Buffer.from(base64, 'base64').toString('utf-8');
      } else {
        jsonPayload = decodeURIComponent(
          atob(base64)
            .split('')
            .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join('')
        );
      }

      return JSON.parse(jsonPayload);
    } catch {
      return null;
    }
  }
}
