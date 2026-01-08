import type { ComponentType, SVGProps } from 'react';
import { cn } from '@/lib/utils';
import type { AgentModel, ModelProvider } from '@automaker/types';
import { getProviderFromModel } from '@/lib/utils';

const PROVIDER_ICON_KEYS = {
  anthropic: 'anthropic',
  openai: 'openai',
  cursor: 'cursor',
  gemini: 'gemini',
  grok: 'grok',
} as const;

type ProviderIconKey = keyof typeof PROVIDER_ICON_KEYS;

interface ProviderIconDefinition {
  viewBox: string;
  path: string;
}

const PROVIDER_ICON_DEFINITIONS: Record<ProviderIconKey, ProviderIconDefinition> = {
  anthropic: {
    viewBox: '0 0 24 24',
    path: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z',
  },
  openai: {
    viewBox: '0 0 158.7128 157.296',
    path: 'M60.8734,57.2556v-14.9432c0-1.2586.4722-2.2029,1.5728-2.8314l30.0443-17.3023c4.0899-2.3593,8.9662-3.4599,13.9988-3.4599,18.8759,0,30.8307,14.6289,30.8307,30.2006,0,1.1007,0,2.3593-.158,3.6178l-31.1446-18.2467c-1.8872-1.1006-3.7754-1.1006-5.6629,0l-39.4812,22.9651ZM131.0276,115.4561v-35.7074c0-2.2028-.9446-3.7756-2.8318-4.8763l-39.481-22.9651,12.8982-7.3934c1.1007-.6285,2.0453-.6285,3.1458,0l30.0441,17.3024c8.6523,5.0341,14.4708,15.7296,14.4708,26.1107,0,11.9539-7.0769,22.965-18.2461,27.527v.0021ZM51.593,83.9964l-12.8982-7.5497c-1.1007-.6285-1.5728-1.5728-1.5728-2.8314v-34.6048c0-16.8303,12.8982-29.5722,30.3585-29.5722,6.607,0,12.7403,2.2029,17.9324,6.1349l-30.987,17.9324c-1.8871,1.1007-2.8314,2.6735-2.8314,4.8764v45.6159l-.0014-.0015ZM79.3562,100.0403l-18.4829-10.3811v-22.0209l18.4829-10.3811,18.4812,10.3811v22.0209l-18.4812,10.3811ZM91.2319,147.8591c-6.607,0-12.7403-2.2031-17.9324-6.1344l30.9866-17.9333c1.8872-1.1005,2.8318-2.6728,2.8318-4.8759v-45.616l13.0564,7.5498c1.1005.6285,1.5723,1.5728,1.5723,2.8314v34.6051c0,16.8297-13.0564,29.5723-30.5147,29.5723v.001ZM53.9522,112.7822l-30.0443-17.3024c-8.652-5.0343-14.471-15.7296-14.471-26.1107,0-12.1119,7.2356-22.9652,18.403-27.5272v35.8634c0,2.2028.9443,3.7756,2.8314,4.8763l39.3248,22.8068-12.8982,7.3938c-1.1007.6287-2.045.6287-3.1456,0ZM52.2229,138.5791c-17.7745,0-30.8306-13.3713-30.8306-29.8871,0-1.2585.1578-2.5169.3143-3.7754l30.987,17.9323c1.8871,1.1005,3.7757,1.1005,5.6628,0l39.4811-22.807v14.9435c0,1.2585-.4721,2.2021-1.5728,2.8308l-30.0443,17.3025c-4.0898,2.359-8.9662,3.4605-13.9989,3.4605h.0014ZM91.2319,157.296c19.0327,0,34.9188-13.5272,38.5383-31.4594,17.6164-4.562,28.9425-21.0779,28.9425-37.908,0-11.0112-4.719-21.7066-13.2133-29.4143.7867-3.3035,1.2595-6.607,1.2595-9.909,0-22.4929-18.2471-39.3247-39.3251-39.3247-4.2461,0-8.3363.6285-12.4262,2.045-7.0792-6.9213-16.8318-11.3254-27.5271-11.3254-19.0331,0-34.9191,13.5268-38.5384,31.4591C11.3255,36.0212,0,52.5373,0,69.3675c0,11.0112,4.7184,21.7065,13.2125,29.4142-.7865,3.3035-1.2586,6.6067-1.2586,9.9092,0,22.4923,18.2466,39.3241,39.3248,39.3241,4.2462,0,8.3362-.6277,12.426-2.0441,7.0776,6.921,16.8302,11.3251,27.5271,11.3251Z',
  },
  cursor: {
    viewBox: '0 0 512 512',
    // Official Cursor logo - hexagonal shape with triangular wedge
    path: 'M415.035 156.35l-151.503-87.4695c-4.865-2.8094-10.868-2.8094-15.733 0l-151.4969 87.4695c-4.0897 2.362-6.6146 6.729-6.6146 11.459v176.383c0 4.73 2.5249 9.097 6.6146 11.458l151.5039 87.47c4.865 2.809 10.868 2.809 15.733 0l151.504-87.47c4.089-2.361 6.614-6.728 6.614-11.458v-176.383c0-4.73-2.525-9.097-6.614-11.459zm-9.516 18.528l-146.255 253.32c-.988 1.707-3.599 1.01-3.599-.967v-165.872c0-3.314-1.771-6.379-4.644-8.044l-143.645-82.932c-1.707-.988-1.01-3.599.968-3.599h292.509c4.154 0 6.75 4.503 4.673 8.101h-.007z',
  },
  gemini: {
    viewBox: '0 0 192 192',
    // Official Google Gemini sparkle logo from gemini.google.com
    path: 'M164.93 86.68c-13.56-5.84-25.42-13.84-35.6-24.01-10.17-10.17-18.18-22.04-24.01-35.6-2.23-5.19-4.04-10.54-5.42-16.02C99.45 9.26 97.85 8 96 8s-3.45 1.26-3.9 3.05c-1.38 5.48-3.18 10.81-5.42 16.02-5.84 13.56-13.84 25.43-24.01 35.6-10.17 10.16-22.04 18.17-35.6 24.01-5.19 2.23-10.54 4.04-16.02 5.42C9.26 92.55 8 94.15 8 96s1.26 3.45 3.05 3.9c5.48 1.38 10.81 3.18 16.02 5.42 13.56 5.84 25.42 13.84 35.6 24.01 10.17 10.17 18.18 22.04 24.01 35.6 2.24 5.2 4.04 10.54 5.42 16.02A4.03 4.03 0 0 0 96 184c1.85 0 3.45-1.26 3.9-3.05 1.38-5.48 3.18-10.81 5.42-16.02 5.84-13.56 13.84-25.42 24.01-35.6 10.17-10.17 22.04-18.18 35.6-24.01 5.2-2.24 10.54-4.04 16.02-5.42A4.03 4.03 0 0 0 184 96c0-1.85-1.26-3.45-3.05-3.9-5.48-1.38-10.81-3.18-16.02-5.42',
  },
  grok: {
    viewBox: '0 0 512 509.641',
    // Official Grok/xAI logo - stylized symbol from grok.com
    path: 'M213.235 306.019l178.976-180.002v.169l51.695-51.763c-.924 1.32-1.86 2.605-2.785 3.89-39.281 54.164-58.46 80.649-43.07 146.922l-.09-.101c10.61 45.11-.744 95.137-37.398 131.836-46.216 46.306-120.167 56.611-181.063 14.928l42.462-19.675c38.863 15.278 81.392 8.57 111.947-22.03 30.566-30.6 37.432-75.159 22.065-112.252-2.92-7.025-11.67-8.795-17.792-4.263l-124.947 92.341zm-25.786 22.437l-.033.034L68.094 435.217c7.565-10.429 16.957-20.294 26.327-30.149 26.428-27.803 52.653-55.359 36.654-94.302-21.422-52.112-8.952-113.177 30.724-152.898 41.243-41.254 101.98-51.661 152.706-30.758 11.23 4.172 21.016 10.114 28.638 15.639l-42.359 19.584c-39.44-16.563-84.629-5.299-112.207 22.313-37.298 37.308-44.84 102.003-1.128 143.81z',
  },
};

export interface ProviderIconProps extends Omit<SVGProps<SVGSVGElement>, 'viewBox'> {
  provider: ProviderIconKey;
  title?: string;
}

export function ProviderIcon({ provider, title, className, ...props }: ProviderIconProps) {
  const definition = PROVIDER_ICON_DEFINITIONS[provider];
  const {
    role,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledby,
    'aria-hidden': ariaHidden,
    ...rest
  } = props;
  const hasAccessibleLabel = Boolean(title || ariaLabel || ariaLabelledby);

  return (
    <svg
      viewBox={definition.viewBox}
      className={cn('inline-block', className)}
      role={role ?? (hasAccessibleLabel ? 'img' : 'presentation')}
      aria-hidden={ariaHidden ?? !hasAccessibleLabel}
      focusable="false"
      {...rest}
    >
      {title && <title>{title}</title>}
      <path d={definition.path} fill="currentColor" />
    </svg>
  );
}

export function AnthropicIcon(props: Omit<ProviderIconProps, 'provider'>) {
  return <ProviderIcon provider={PROVIDER_ICON_KEYS.anthropic} {...props} />;
}

export function OpenAIIcon(props: Omit<ProviderIconProps, 'provider'>) {
  return <ProviderIcon provider={PROVIDER_ICON_KEYS.openai} {...props} />;
}

export function CursorIcon(props: Omit<ProviderIconProps, 'provider'>) {
  return <ProviderIcon provider={PROVIDER_ICON_KEYS.cursor} {...props} />;
}

export function GeminiIcon(props: Omit<ProviderIconProps, 'provider'>) {
  return <ProviderIcon provider={PROVIDER_ICON_KEYS.gemini} {...props} />;
}

export function GrokIcon(props: Omit<ProviderIconProps, 'provider'>) {
  return <ProviderIcon provider={PROVIDER_ICON_KEYS.grok} {...props} />;
}

export const PROVIDER_ICON_COMPONENTS: Record<
  ModelProvider,
  ComponentType<{ className?: string }>
> = {
  claude: AnthropicIcon,
  cursor: CursorIcon, // Default for Cursor provider (will be overridden by getProviderIconForModel)
  codex: OpenAIIcon,
};

/**
 * Get the underlying model icon based on the model string
 * For Cursor models, detects whether it's Claude, GPT, Gemini, Grok, or Cursor-specific
 */
function getUnderlyingModelIcon(model?: AgentModel | string): ProviderIconKey {
  if (!model) return 'anthropic';

  const modelStr = typeof model === 'string' ? model.toLowerCase() : model;

  // Check for Cursor-specific models with underlying providers
  if (modelStr.includes('sonnet') || modelStr.includes('opus') || modelStr.includes('claude')) {
    return 'anthropic';
  }
  if (modelStr.includes('gpt-') || modelStr.includes('codex')) {
    return 'openai';
  }
  if (modelStr.includes('gemini')) {
    return 'gemini';
  }
  if (modelStr.includes('grok')) {
    return 'grok';
  }
  if (modelStr.includes('cursor') || modelStr === 'auto' || modelStr === 'composer-1') {
    return 'cursor';
  }

  // Default based on provider
  const provider = getProviderFromModel(model);
  if (provider === 'codex') return 'openai';
  if (provider === 'cursor') return 'cursor';
  return 'anthropic';
}

export function getProviderIconForModel(
  model?: AgentModel | string
): ComponentType<{ className?: string }> {
  const iconKey = getUnderlyingModelIcon(model);

  const iconMap: Record<ProviderIconKey, ComponentType<{ className?: string }>> = {
    anthropic: AnthropicIcon,
    openai: OpenAIIcon,
    cursor: CursorIcon,
    gemini: GeminiIcon,
    grok: GrokIcon,
  };

  return iconMap[iconKey] || AnthropicIcon;
}
