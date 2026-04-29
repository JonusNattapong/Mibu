import React, { useState, useEffect, useRef, useMemo } from 'react';
import { render, Box, Text, useInput, useApp, Static, Spacer, Newline } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import Gradient from 'ink-gradient';
import BigText from 'ink-big-text';
import { createParser, EventSourceMessage } from 'eventsource-parser';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import gradient from 'gradient-string';
import { logger } from '../src/runtime/logger';
import configManager, { ProviderProfile } from '../src/config/configManager';
import keyPool from '../src/providers/keyPool';
import providersConfig from '../src/config/providers.json';
const DEFAULT_BASE_URL = 'http://localhost:4040';

// Tactical Theme (Tactical Sunset)
const THEME = {
  primary: '#D97757',   // Rust Orange
  secondary: '#FCAB64', // Sandy Orange
  accent: '#A7C957',    // Tactical Green
  error: '#BC4749',     // Crimson
  bg: '#1A1A1B',        // Noir
  dim: '#6D6D6E'         // Steel
};

interface MissionLog {
  id: string;
  timestamp: string;
  message: string;
  type: 'system' | 'intelligence' | 'error' | 'success' | 'tool' | 'insight';
}

interface MissionStartOptions {
  target?: string;
  goal?: string;
  labMode?: boolean;
}

const App = () => {
  const { exit } = useApp();
  const [step, setStep] = useState<'welcome' | 'setup' | 'audit' | 'report' | 'config' | 'intelligence_keys'>('welcome');
  const [target, setTarget] = useState('');
  const [goal, setGoal] = useState('');
  const [logs, setLogs] = useState<MissionLog[]>([]);
  const [streamingLog, setStreamingLog] = useState<MissionLog | null>(null);
  const [missionComplete, setMissionComplete] = useState(false);
  const [finalAnalysisResult, setFinalAnalysisResult] = useState('');
  const [streamingDraft, setStreamingDraft] = useState('');
  const [latestDraft, setLatestDraft] = useState<any>(null);
  const [thoughts, setThoughts] = useState<string[]>([]);
  const [turn, setTurn] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStartingMission, setIsStartingMission] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [stats, setStats] = useState({ critical: 0, high: 0, medium: 0, memory: 0 });

  const [provider, setProvider] = useState(process.env.DEFAULT_PROVIDER || 'kilocode');
  const [model, setModel] = useState('');
  const [profileName, setProfileName] = useState('Default');

  const [isLabMode, setIsLabMode] = useState(false);
  const [tempTarget, setTempTarget] = useState('');
  const [tempGoal, setTempGoal] = useState('');

  const pendingLogsRef = useRef<MissionLog[]>([]);
  const activeRevealRef = useRef<{ log: MissionLog; cursor: number } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const clearLogStream = () => {
    pendingLogsRef.current = [];
    activeRevealRef.current = null;
    setLogs([]);
    setStreamingLog(null);
  };

  useEffect(() => {
    const timer = setInterval(() => {
      const revealSpeed = 8;
      if (!activeRevealRef.current && pendingLogsRef.current.length > 0) {
        const nextLog = pendingLogsRef.current.shift()!;
        activeRevealRef.current = { log: nextLog, cursor: 0 };
        setStreamingLog({ ...nextLog, message: '' });
      }
      const active = activeRevealRef.current;
      if (!active) return;
      const nextCursor = Math.min(active.log.message.length, active.cursor + revealSpeed);
      const partial = active.log.message.slice(0, nextCursor);
      setStreamingLog(prev => prev ? { ...prev, message: partial } : prev);
      active.cursor = nextCursor;
      if (nextCursor >= active.log.message.length) {
        setLogs(prev => [...prev, active.log]);
        setStreamingLog(null);
        activeRevealRef.current = null;
      }
    }, 18);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const activeProfile = configManager.getActiveProfile();
    const { saveProfile, setActiveProfile, updateProfile, switchTacticalModel, removeProfile } = configManager;
    if (activeProfile) {
      setProvider(activeProfile.provider);
      setModel(activeProfile.model || '');
      setProfileName(activeProfile.name);
    }
  }, [step]);

  useEffect(() => {
    let timer: any;
    if (isStreaming) {
      timer = setInterval(() => {
        setElapsed(prev => prev + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isStreaming]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  useInput((input, key) => {
    if (key.escape) {
      if (step === 'setup' || step === 'config' || step === 'intelligence_keys') {
        setStep('welcome');
        setIsStartingMission(false);
      } else if (step === 'audit' || step === 'report') {
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        setIsStreaming(false);
        setStep('welcome');
        setIsStartingMission(false);
      } else {
        exit();
      }
    }
  });

  const addLog = (message: string, type: MissionLog['type'] = 'system') => {
    const id = Math.random().toString(36).substring(7);
    const timestamp = new Date().toLocaleTimeString();
    pendingLogsRef.current.push({ id, timestamp, message, type });
  };

  const startMission = async (options: MissionStartOptions = {}) => {
    const missionTarget = options.target ?? tempTarget;
    const missionGoal = options.goal ?? tempGoal;
    if (!missionTarget || isStartingMission) return;

    setIsStartingMission(true);
    setIsLabMode(!!options.labMode);
    setTarget(missionTarget);
    setGoal(missionGoal);
    setStep('audit');
    clearLogStream();
    setThoughts([]);
    setMissionComplete(false);
    setFinalAnalysisResult('');
    setStreamingDraft('');
    setStats({ critical: 0, high: 0, medium: 0, memory: 0 });
    setTurn(0);
    setIsStreaming(true);

    const activeProfile = configManager.getActiveProfile();
    const finalArgs = {
      url: missionTarget,
      goal: missionGoal,
      outputStyle: 'agent',
      provider: activeProfile?.provider || provider,
      model: activeProfile?.model || model,
      browserVisible: activeProfile?.browserVisible,
      sessionId: `tui-${Date.now()}`
    };

    try {
      addLog(`Mission Initialized: ${profileName}`, 'system');
      addLog(`Target: ${missionTarget}`, 'system');

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

      const response = await fetch(`${DEFAULT_BASE_URL}/api/agent/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalArgs),
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      
      setIsStartingMission(false); // Reset once streaming begins

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Response body is empty');

      const decoder = new TextDecoder();
      const parser = createParser({
        onEvent: (event: EventSourceMessage) => {
          if (event.data === '[DONE]') {
            setIsStreaming(false);
            setMissionComplete(true);
            return;
          }
          try {
            const data = JSON.parse(event.data);
            if (data.log) {
              let type: MissionLog['type'] = 'system';
              if (data.log.includes('[Intelligence]')) type = 'intelligence';
              if (data.log.includes('[Insight]')) type = 'insight';
              if (data.log.includes('[Tool Call]')) type = 'tool';
              if (data.log.includes('[Error]')) type = 'error';
              addLog(data.log, type);

              // Update Tactical Stats
              if (data.log.includes('severity":"CRITICAL') || data.log.includes('severity: "CRITICAL')) setStats(s => ({ ...s, critical: s.critical + 1 }));
              if (data.log.includes('severity":"HIGH') || data.log.includes('severity: "HIGH')) setStats(s => ({ ...s, high: s.high + 1 }));
              if (data.log.includes('severity":"MEDIUM') || data.log.includes('severity: "MEDIUM')) setStats(s => ({ ...s, medium: s.medium + 1 }));
              if (data.log.includes('recorded in memory')) setStats(s => ({ ...s, memory: s.memory + 1 }));
            }
            if (data.chunk) setStreamingDraft(prev => prev + data.chunk);
            if (data.thought) setThoughts(prev => [...prev, data.thought]);
            if (data.draft) {
              if (data.draft.type === 'final_report') {
                setFinalAnalysisResult(data.draft.content);
              } else {
                setLatestDraft(data.draft);
              }
            }
          } catch (e) {}
        }
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value));
      }
    } catch (err: any) {
      addLog(`Fatal Error: ${err.message}`, 'error');
      setIsStreaming(false);
      setMissionComplete(true);
    } finally {
      setIsStartingMission(false);
    }
  };

  const WelcomeStep = () => {
    const [menuItems, setMenuItems] = useState<any[]>([]);
    const [verbIndex, setVerbIndex] = useState(0);
    const [iconIndex, setIconIndex] = useState(0);
    const TACTICAL_VERBS = [
      'Gitifying', 'Quantumizing', 'Clauding', 'Architecting', 'Bootstrapping', 
      'Combobulating', 'Discombobulating', 'Hyperspacing', 'Ionizing', 'Metamorphosing'
    ];
    const TACTICAL_ICONS = ['✛', '✢', '✳', '✶', '✻', '✽'];

    useEffect(() => {
      const verbInterval = setInterval(() => {
        setVerbIndex(prev => (prev + 1) % TACTICAL_VERBS.length);
      }, 1500);
      const iconInterval = setInterval(() => {
        setIconIndex(prev => (prev + 1) % TACTICAL_ICONS.length);
      }, 120);
      return () => {
        clearInterval(verbInterval);
        clearInterval(iconInterval);
      };
    }, []);

    useEffect(() => {
      const fallbackMenu = [
        { label: 'START AUTONOMOUS REDTEAM', value: 'agent', color: THEME.primary },
        { label: 'TRAINING SECURITY LAB (PORT 8080)', value: 'lab', color: THEME.secondary },
        { label: 'ENVIRONMENT SETTINGS', value: 'config', color: THEME.accent },
        { label: 'INTELLIGENCE KEYS', value: 'intelligence_keys', color: THEME.accent },
        { label: 'EXIT REDLOCK', value: 'exit', color: THEME.dim }
      ];
      try {
        const menuPath = path.join(process.cwd(), 'cli', 'menu_config.json');
        if (fs.existsSync(menuPath)) {
          const config = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
          setMenuItems(config.map((item: any) => ({
            label: item.label,
            value: item.id,
            description: item.description,
            color: item.color
          })));
        } else { setMenuItems(fallbackMenu); }
      } catch (e) { setMenuItems(fallbackMenu); }
    }, []);

    const handleSelect = (item: any) => {
      if (item.value === 'agent') { setStep('setup'); setTempGoal('Perform security audit.'); }
      else if (item.value === 'lab') {
        setIsLabMode(true); setTempTarget('http://localhost:8080'); setTempGoal('Lab Security Audit.');
        try {
          const { spawn } = require('child_process');
          spawn('bun', [path.join(process.cwd(), 'lab', 'lab_target.ts')], { detached: true, stdio: 'ignore' }).unref();
        } catch (e) {}
        setTimeout(() => startMission({ target: 'http://localhost:8080', goal: 'Lab Security Audit.', labMode: true }), 500);
      }
      else if (item.value === 'config') { setStep('config'); }
      else if (item.value === 'intelligence_keys') { setStep('intelligence_keys'); }
      else if (item.value === 'exit') { process.exit(0); }
    };

    const logo = `▄▄▄▄▄▄▄    ▄▄▄▄▄▄▄ ▄▄▄▄▄▄   ▄▄▄        ▄▄▄▄▄    ▄▄▄▄▄▄▄ ▄▄▄   ▄▄▄ 
███▀▀███▄ ███▀▀▀▀▀ ███▀▀██▄ ███      ▄███████▄ ███▀▀▀▀▀ ███ ▄███▀ 
███▄▄███▀ ███▄▄    ███  ███ ███      ███   ███ ███      ███████   
███▀▀██▄  ███      ███  ███ ███      ███▄▄▄███ ███      ███▀███▄  
███  ▀███ ▀███████ ██████▀  ████████  ▀█████▀  ▀███████ ███  ▀███`;

    return (
      <Box flexDirection="column">
        <Gradient colors={["#D97757", "#FCAB64", "#D97757"]}><Text bold>{logo}</Text></Gradient>
        <Box marginTop={1}><SelectInput items={menuItems} onSelect={handleSelect} /></Box>
        
        {isStartingMission && (
          <Box marginTop={1}>
            <Text color={THEME.accent}>
              <Spinner type="dots" /> <Text bold>{TACTICAL_ICONS[iconIndex]}</Text> {TACTICAL_VERBS[verbIndex]}...
            </Text>
          </Box>
        )}

        <Spacer />
        <Box marginTop={1}><Text color={THEME.dim}>Active Profile: </Text><Text color={THEME.accent} bold>{profileName} [{provider}:{model || 'auto'}]</Text></Box>
      </Box>
    );
  };

  const SetupStep = () => {
    useInput((i, k) => { if (k.return) startMission(); });
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={THEME.primary}>MISSION PARAMETERS</Text>
        <Box marginTop={1} flexDirection="column">
          <Box><Text color={THEME.secondary}>Target: </Text><TextInput value={tempTarget} onChange={setTempTarget} /></Box>
          <Box><Text color={THEME.secondary}>Goal  : </Text><TextInput value={tempGoal} onChange={setTempGoal} /></Box>
        </Box>
        <Box marginTop={1}><Text color={THEME.accent}>[Enter to Start | Esc to Back]</Text></Box>
      </Box>
    );
  };

  const IntelligenceKeysStep = () => {
    const [tavily, setTavily] = useState(configManager.get('TAVILY_API_KEY') || '');
    const [brave, setBrave] = useState(configManager.get('BRAVE_SEARCH_API_KEY') || '');
    const [focus, setFocus] = useState<'tavily' | 'brave'>('tavily');
    const save = () => { configManager.set('TAVILY_API_KEY', tavily); configManager.set('BRAVE_SEARCH_API_KEY', brave); setStep('welcome'); };
    useInput((i, k) => { if (k.return) save(); if (k.tab || k.downArrow || k.upArrow) setFocus(f => f === 'tavily' ? 'brave' : 'tavily'); });
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={THEME.primary}>ENVIRONMENT SETTINGS & PROFILE VAULT</Text>
        <Box marginTop={1} marginBottom={1}>
          <Text bold color={THEME.accent}>» INTELLIGENCE KEYS</Text>
        </Box>

        <Box marginTop={0} borderStyle="round" borderColor={THEME.dim} flexDirection="column" paddingX={1} paddingY={0}>
          <Box flexDirection="column">
            <Box paddingBottom={1}>
              <Text color="#a3e635">⬖ SEARCH ENGINE API KEYS (Use Tab/Arrows to switch):</Text>
            </Box>
            
            <Box flexDirection="row" marginBottom={1}>
              <Text color={focus === 'tavily' ? THEME.accent : 'white'}>TAVILY KEY: </Text>
              <TextInput value={tavily} onChange={setTavily} focus={focus === 'tavily'} mask="*" />
            </Box>
            
            <Box flexDirection="row">
              <Text color={focus === 'brave' ? THEME.accent : 'white'}>BRAVE KEY : </Text>
              <TextInput value={brave} onChange={setBrave} focus={focus === 'brave'} mask="*" />
            </Box>

            <Box marginTop={1} paddingBottom={0}>
              <Text color={THEME.dim} italic>(Enter to Save | Esc to Back)</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    );
  };

  const ConfigStep = () => {
    const [subStep, setSubStep] = useState<'list' | 'edit' | 'select-provider' | 'select-model'>('list');
    const [selectedProfile, setSelectedProfile] = useState<any>(null);
    const [focusIndex, setFocusIndex] = useState(0); // 0:Name, 1:Provider, 2:API Key, 3:Model, 4:Save, 5:Activate, 6:Delete
    const [isTypingModel, setIsTypingModel] = useState(false);
    const [isTypingVision, setIsTypingVision] = useState(false);
    const [modelTarget, setModelTarget] = useState<'main' | 'vision'>('main');
    const [fetchedModels, setFetchedModels] = useState<any[] | null>(null);
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [modelSearchQuery, setModelSearchQuery] = useState('');

    const profiles = configManager.getProfiles();
    const activeProfile = configManager.getActiveProfile();
    
    const items = profiles.map(p => {
      const isActive = p.id === activeProfile?.id;
      return { 
        label: isActive ? chalk.green(`◈ ${p.name.toUpperCase()} (ACTIVE)`) : `  ${p.name.toUpperCase()}`, 
        value: p.id 
      };
    });
    items.push({ label: '  [ + Add New Profile ]', value: '__add__' });

    const PROVIDERS = Object.keys(providersConfig).map(key => ({
      label: (providersConfig as any)[key].label || key,
      value: key
    }));

    const MODELS: Record<string, any[]> = {
      kilocode: [{label: 'kilo-auto/free', value: 'kilo-auto/free'}, {label: 'kilo-auto/balanced', value: 'kilo-auto/balanced'}],
      openai: [{label: 'gpt-5.4-mini', value: 'gpt-5.4-mini'}, {label: 'gpt-4o', value: 'gpt-4o'}, {label: 'gpt-4o-mini', value: 'gpt-4o-mini'}],
      anthropic: [{label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6'}, {label: 'claude-3-5-sonnet-20240620', value: 'claude-3-5-sonnet-20240620'}],
      gemini: [{label: 'gemini-2.5-flash', value: 'gemini-2.5-flash'}, {label: 'gemini-1.5-pro', value: 'gemini-1.5-pro'}],
      ollama: [{label: 'llama3.3', value: 'llama3.3'}, {label: 'mistral', value: 'mistral'}],
      opencode: [{label: 'qwen3.6-plus', value: 'qwen3.6-plus'}, {label: 'minimax-m2.7', value: 'minimax-m2.7'}, {label: 'glm-5.1', value: 'glm-5.1'}],
      xai: [{label: 'grok-4.20-non-reasoning', value: 'grok-4.20-non-reasoning'}, {label: 'grok-4.20-reasoning', value: 'grok-4.20-reasoning'}],
      mistral: [{label: 'mistral-large-latest', value: 'mistral-large-latest'}],
      groq: [{label: 'llama-3.3-70b-versatile', value: 'llama-3.3-70b-versatile'}],
      openrouter: [{label: 'openai/gpt-5.4-mini', value: 'openai/gpt-5.4-mini'}],
      cline: [{label: 'anthropic/claude-sonnet-4-6', value: 'anthropic/claude-sonnet-4-6'}],
      deepseek: [{label: 'deepseek-chat', value: 'deepseek-chat'}, {label: 'deepseek-reasoner', value: 'deepseek-reasoner'}]
    };

    Object.keys(providersConfig).forEach(key => {
      const p = (providersConfig as any)[key];
      if (!MODELS[key]) MODELS[key] = [];
      if (p.model && !MODELS[key].find(m => m.value === p.model)) {
        MODELS[key].unshift({label: p.model + ' (Default)', value: p.model});
      }
      MODELS[key].push({label: '[ Type Custom Model ]', value: '__custom__'});
    });

    const handleSelect = (item: any) => {
      if (item.value === '__add__') {
        const newProfile = { id: `profile_${Date.now()}`, name: 'New Profile', provider: 'openai', model: '' };
        setSelectedProfile(newProfile);
        setSubStep('edit');
        setFocusIndex(0);
      } else {
        const p = profiles.find(x => x.id === item.value);
        if (p) { setSelectedProfile({ ...p }); setSubStep('edit'); setFocusIndex(0); }
      }
    };

    const doSave = () => { if (selectedProfile) { configManager.saveProfile(selectedProfile); addLog(`KEYS: Profile [${selectedProfile.name}] saved.`, 'success'); setStep('welcome'); } };
    const doActivate = () => { if (selectedProfile) { configManager.setActiveProfile(selectedProfile.id); addLog(`TACTICAL: Profile [${selectedProfile.name}] activated.`, 'success'); setStep('welcome'); } };
    const doDelete = () => { if (selectedProfile) { configManager.removeProfile(selectedProfile.id); setSubStep('list'); } };

    useInput((i, k) => {
      if (subStep === 'edit') {
        if (k.return) {
          if (focusIndex === 1) setSubStep('select-provider');
          else if (focusIndex === 3) { setModelTarget('main'); setSubStep('select-model'); setModelSearchQuery(''); }
          else if (focusIndex === 4) { setModelTarget('vision'); setSubStep('select-model'); setModelSearchQuery(''); }
          else if (focusIndex === 5) doSave();
          else if (focusIndex === 6) doActivate();
          else if (focusIndex === 7) doDelete();
        }
        if (k.upArrow) setFocusIndex(prev => Math.max(0, prev - 1));
        if (k.downArrow) setFocusIndex(prev => Math.min(7, prev + 1));
        if (k.leftArrow && focusIndex >= 5) setFocusIndex(prev => Math.max(5, prev - 1));
        if (k.rightArrow && focusIndex >= 5) setFocusIndex(prev => Math.min(7, prev + 1));
      }
    });

    useEffect(() => {
      if (subStep === 'select-model' && selectedProfile?.provider) {
        setIsFetchingModels(true);
        setFetchedModels(null);
        
        const fetchModels = async () => {
          try {
            const providerConfig = (providersConfig as any)[selectedProfile.provider];
            if (!providerConfig || !providerConfig.modelsUrl) throw new Error('No modelsUrl');
            
            let apiKey = selectedProfile.apiKey;
            if (!apiKey && providerConfig.env_key) {
              apiKey = process.env[providerConfig.env_key];
            }
            
            const headers: Record<string, string> = {};
            if (apiKey) {
              headers['Authorization'] = `Bearer ${apiKey}`;
              headers['x-api-key'] = apiKey;
            }
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            const res = await fetch(providerConfig.modelsUrl, { 
              headers, 
              signal: controller.signal 
            });
            clearTimeout(timeoutId);
            
            if (res.ok) {
              const data = await res.json();
              let mList: string[] = [];
              if (data.data && Array.isArray(data.data)) mList = data.data.map((m: any) => m.id);
              else if (data.models && Array.isArray(data.models)) mList = data.models.map((m: any) => m.name || m.id);
              else if (Array.isArray(data)) mList = data.map(m => m.id || m.name);
              
              if (mList.length > 0) {
                mList.sort();
                setFetchedModels(mList.map(m => ({label: m, value: m})));
                return;
              }
            }
          } catch (e) {
            // Fail silently and use fallback
          }
          setFetchedModels([]); // Empty array signals fallback to static list
        };
        
        fetchModels().finally(() => setIsFetchingModels(false));
      }
    }, [subStep, selectedProfile?.provider, selectedProfile?.apiKey]);

    if (subStep === 'select-provider') {
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold color={THEME.primary}>ENVIRONMENT SETTINGS & PROFILE VAULT</Text>
          <Box marginTop={1} marginBottom={1}>
            <Text bold color={THEME.accent}>» CONFIGURE PROVIDER</Text>
          </Box>

          <Box>
            <Text>Provider: </Text>
            <Text color={THEME.accent}>{selectedProfile?.provider || ''}</Text>
          </Box>

          <Box marginTop={1} borderStyle="round" borderColor={THEME.dim} flexDirection="column" paddingX={1} paddingY={0}>
            <Box flexDirection="column">
              <Box paddingBottom={1}>
                <Text color="#a3e635">⬖ PROVIDER VAULT (Use Arrow Up/Down to select):</Text>
              </Box>
              <SelectInput items={PROVIDERS} limit={10} onSelect={item => { setSelectedProfile({...selectedProfile, provider: item.value, model: ''}); setSubStep('edit'); }} />
              <Box marginTop={1} paddingBottom={0}>
                <Text color={THEME.dim} italic>(Arrows to select | Enter to save)</Text>
              </Box>
            </Box>
          </Box>
        </Box>
      );
    }

    if (subStep === 'select-model') {
      let modelOptions = MODELS[selectedProfile.provider] || [{label: 'default', value: 'default'}, {label: '[ Type Custom Model ]', value: '__custom__'}];
      if (fetchedModels && fetchedModels.length > 0) {
         modelOptions = [...fetchedModels, {label: '[ Type Custom Model ]', value: '__custom__'}];
      }

      const filteredOptions = modelOptions.filter(m => m.label.toLowerCase().includes(modelSearchQuery.toLowerCase()));
      const displayOptions = filteredOptions.length > 0 ? filteredOptions : [{label: 'No matches found', value: '__none__'}];

      return (
        <Box flexDirection="column" padding={1}>
          <Text bold color={THEME.primary}>ENVIRONMENT SETTINGS & PROFILE VAULT</Text>
          <Box marginTop={1} marginBottom={1}>
            <Text bold color={THEME.accent}>» CONFIGURE MODEL ID</Text>
          </Box>

          <Box>
            <Text>Model ID: </Text>
            <TextInput value={modelSearchQuery} onChange={setModelSearchQuery} focus={true} />
          </Box>

          <Box marginTop={1} borderStyle="round" borderColor={THEME.dim} flexDirection="column" paddingX={1} paddingY={0}>
            {isFetchingModels ? (
              <Box paddingY={1}>
                <Text color={THEME.accent}><Spinner type="dots" /> Fetching models from API...</Text>
              </Box>
            ) : (
              <Box flexDirection="column">
                <Box paddingBottom={1}>
                  <Text color="#a3e635">⬖ INTELLIGENCE SUGGESTIONS (Use Arrow Up/Down to select):</Text>
                </Box>
                <SelectInput limit={10} items={displayOptions} onSelect={item => { 
                  if (item.value === '__none__') return;
                  if (item.value === '__custom__') {
                    if (modelTarget === 'main') setIsTypingModel(true);
                    else setIsTypingVision(true);
                  } else {
                    if (modelTarget === 'main') {
                      setSelectedProfile({...selectedProfile, model: item.value}); 
                      setIsTypingModel(false);
                    } else {
                      setSelectedProfile({...selectedProfile, visionModel: item.value}); 
                      setIsTypingVision(false);
                    }
                  }
                  setModelSearchQuery('');
                  setSubStep('edit'); 
                }} />
                <Box marginTop={1} paddingBottom={0}>
                  <Text color={THEME.dim} italic>(Type to filter | Arrows to select | Enter to save)</Text>
                </Box>
              </Box>
            )}
          </Box>
        </Box>
      );
    }

    if (subStep === 'edit' && selectedProfile) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold color={THEME.primary}>EDIT PROFILE: {selectedProfile.name}</Text>
          <Box flexDirection="column" marginTop={1} marginBottom={1}>
            <Box><Text color={focusIndex === 0 ? THEME.accent : 'white'}>Name    : </Text><TextInput focus={focusIndex === 0} value={selectedProfile.name} onChange={v => setSelectedProfile({...selectedProfile, name: v})} /></Box>
            <Box>
              <Text color={focusIndex === 1 ? THEME.accent : 'white'}>Provider: </Text>
              <Text color={focusIndex === 1 ? 'white' : THEME.dim}>{selectedProfile.provider}</Text>
              {focusIndex === 1 && <Text color={THEME.accent}> [Press Enter to Select]</Text>}
            </Box>
            <Box><Text color={focusIndex === 2 ? THEME.accent : 'white'}>API Key : </Text><TextInput focus={focusIndex === 2} value={selectedProfile.apiKey || ''} onChange={v => setSelectedProfile({...selectedProfile, apiKey: v})} mask="*" /></Box>
            <Box>
              <Text color={focusIndex === 3 ? THEME.accent : 'white'}>Model   : </Text>
              {isTypingModel ? (
                <TextInput focus={focusIndex === 3} value={selectedProfile.model || ''} onChange={v => setSelectedProfile({...selectedProfile, model: v})} />
              ) : (
                <Text color={focusIndex === 3 ? 'white' : THEME.dim}>{selectedProfile.model || 'auto'}</Text>
              )}
              {focusIndex === 3 && !isTypingModel && <Text color={THEME.accent}> [Press Enter to Select]</Text>}
            </Box>
            <Box>
              <Text color={focusIndex === 4 ? THEME.accent : 'white'}>Vision M: </Text>
              {isTypingVision ? (
                <TextInput focus={focusIndex === 4} value={selectedProfile.visionModel || ''} onChange={v => setSelectedProfile({...selectedProfile, visionModel: v})} />
              ) : (
                <Text color={focusIndex === 4 ? 'white' : THEME.dim}>{selectedProfile.visionModel || 'none'}</Text>
              )}
              {focusIndex === 4 && !isTypingVision && <Text color={THEME.accent}> [Press Enter to Select]</Text>}
            </Box>
          </Box>
          
          <Box flexDirection="row">
            <Box borderStyle="round" borderColor={focusIndex === 5 ? THEME.accent : THEME.dim} paddingX={1} marginRight={1}>
              <Text bold={focusIndex === 5} color={focusIndex === 5 ? THEME.accent : 'white'}> SAVE </Text>
            </Box>
            <Box borderStyle="round" borderColor={focusIndex === 6 ? THEME.accent : THEME.dim} paddingX={1} marginRight={1}>
              <Text bold={focusIndex === 6} color={focusIndex === 6 ? THEME.accent : 'white'}> ACTIVATE </Text>
            </Box>
            <Box borderStyle="round" borderColor={focusIndex === 7 ? THEME.error : THEME.dim} paddingX={1}>
              <Text bold={focusIndex === 7} color={focusIndex === 7 ? THEME.error : 'white'}> DELETE </Text>
            </Box>
          </Box>
          
          <Box marginTop={1}><Text color={THEME.dim}>[Arrows to Move | Enter to Execute | Esc to Back]</Text></Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={THEME.primary}>ENVIRONMENT SETTINGS & PROFILE VAULT</Text>
        <Box marginTop={1} marginBottom={1}>
          <Text bold color={THEME.accent}>» PROFILE MANAGEMENT</Text>
        </Box>

        <Box marginTop={1} borderStyle="round" borderColor={THEME.dim} flexDirection="column" paddingX={1} paddingY={0}>
          <Box flexDirection="column">
            <Box paddingBottom={1}>
              <Text color="#a3e635">⬖ SELECT PROFILE TO EDIT/ACTIVATE (Use Arrow Up/Down to select):</Text>
            </Box>
            <SelectInput limit={10} items={items} onSelect={handleSelect} />
            <Box marginTop={1} paddingBottom={0}>
              <Text color={THEME.dim} italic>(Arrows to select | Enter to open | Esc to Back)</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    );
  };

  const AuditStep = () => {
    const currentTurn = turn || 1;
    let phase = 'RECONNAISSANCE';
    let progress = 0.25;
    let color = '#38bdf8';

    // Parse actual phase from thoughts if available
    const lastThought = thoughts[thoughts.length - 1] || '';
    const phaseMatch = lastThought.match(/\[PHASE:\s*(.*?)\]/i);
    const actualPhase = phaseMatch ? phaseMatch[1].toUpperCase() : null;

    if (missionComplete) {
      phase = 'MISSION COMPLETE';
      progress = 1.0;
      color = '#a3e635';
    } else if (actualPhase) {
      phase = actualPhase;
      if (phase.includes('RECON')) { progress = 0.25; color = '#38bdf8'; }
      else if (phase.includes('SCAN') || phase.includes('VULN')) { progress = 0.5; color = '#fbbf24'; }
      else if (phase.includes('EXPLOIT')) { progress = 0.75; color = '#f87171'; }
      else if (phase.includes('DOSSIER') || phase.includes('SYNTH')) { progress = 1.0; color = '#a3e635'; }
    } else {
      // Fallback to turn-based if agent hasn't reported yet
      if (currentTurn <= 3) { phase = 'RECONNAISSANCE'; progress = 0.25; color = '#38bdf8'; }
      else if (currentTurn <= 7) { phase = 'VULNERABILITY SCAN'; progress = 0.5; color = '#fbbf24'; }
      else if (currentTurn <= 12) { phase = 'ACTIVE EXPLOITATION'; progress = 0.75; color = '#f87171'; }
      else { phase = 'DOSSIER SYNTHESIS'; progress = 1.0; color = '#a3e635'; }
    }

    const progressBarWidth = 30;
    const filledWidth = Math.floor(progress * progressBarWidth);
    const bar = '█'.repeat(filledWidth) + '░'.repeat(progressBarWidth - filledWidth);

    return (
      <Box flexDirection="column" height="100%">
        <Box flexDirection="column" flexGrow={1} overflowY="hidden" borderStyle="single" borderColor={THEME.dim} paddingX={1}>
          {logs.slice(-100).map(log => {
            let color = log.type === 'error' ? THEME.error : log.type === 'success' ? THEME.accent : 'white';
            let bold = false;
            let message = log.message;

            if (message.includes(' ◈ ')) { color = THEME.primary; bold = true; } 
            else if (message.includes('  ↳ ')) { color = THEME.secondary; } 
            else if (message.includes('[System]')) { color = THEME.dim; } 
            else if (log.type === 'insight') { color = THEME.accent; bold = true; }

            return (
              <Text key={log.id} color={color} bold={bold}>
                [{log.timestamp}] {message}
              </Text>
            );
          })}
          {streamingLog && <Text color={THEME.secondary}>[{streamingLog.timestamp}] {streamingLog.message}_</Text>}
        </Box>

        <Box borderStyle="bold" borderColor={THEME.primary} paddingX={1} flexDirection="column" marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Box><Text bold color={THEME.accent}>MISSION: {target}</Text></Box>
            <Box>
              <Text color="#ef4444" bold> [CRITICAL: {stats.critical}] </Text>
              <Text color="#f97316" bold> [HIGH: {stats.high}] </Text>
              <Text color="#eab308" bold> [MED: {stats.medium}] </Text>
              <Text color="#8b5cf6" bold> [MEM: {stats.memory}] </Text>
            </Box>
          </Box>
          
          <Box marginTop={1} borderStyle="round" borderColor={THEME.dim} paddingX={1}>
            <Text italic color={THEME.accent}>💭 THOUGHT: {thoughts[thoughts.length - 1] || 'Analyzing tactical vectors...'}</Text>
          </Box>

          <Box flexDirection="row" marginTop={0}>
            <Text color={THEME.dim}>PROFILING: </Text>
            <Text color={THEME.primary} bold>{profileName} </Text>
            <Text color={THEME.dim}>[{provider}:{model || 'auto'}]</Text>
            <Spacer />
            <Text color={THEME.dim}>TIME: </Text>
            <Text color={THEME.accent}>{formatTime(elapsed)} </Text>
            <Text color={THEME.dim}>[ {isStreaming ? chalk.yellow("ENGAGED") : chalk.green("STABLE")} ]</Text>
          </Box>
        </Box>

        {missionComplete && !isStreaming && (finalAnalysisResult || streamingDraft || latestDraft) && (
          <Box flexDirection="column" borderStyle="single" borderColor={THEME.secondary} paddingX={2} marginY={1}>
            <Text bold color={THEME.secondary}>📄 MISSION INTELLIGENCE DOSSIER</Text>
            <Box marginTop={1}>
              <Text color="white">{finalAnalysisResult || streamingDraft || latestDraft}</Text>
            </Box>
          </Box>
        )}

        {missionComplete && (
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={THEME.dim} paddingX={1}>
            <Text bold color={THEME.primary}>Insight Delivery & Export ---------</Text>
            <Box marginTop={1} paddingBottom={1}>
              <Text color="#a3e635">? What would you like to do with the result? (Use arrow keys)</Text>
            </Box>
            <SelectInput 
              items={[
                { label: '> Copy to Clipboard', value: 'clip' },
                { label: '[F] Export as Markdown (.md)', value: 'md' },
                { label: '[F] Export as Plain Text (.txt)', value: 'txt' },
                { label: '[F] Export as JSON (.json)', value: 'json' },
                { label: '[R] Start New Mission (Main Menu)', value: 'main' },
                { label: '[S] Change Provider/Settings', value: 'settings' },
                { label: '√ Done (Quit)', value: 'quit' }
              ]} 
              onSelect={(item) => {
                if (item.value === 'main') setStep('welcome');
                else if (item.value === 'settings') setStep('config');
                else if (item.value === 'quit') process.exit(0);
                else {
                  const exportDir = path.join(os.homedir(), '.redrock', 'dossiers');
                  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
                  
                  const ts = new Date().toISOString().replace(/[:.]/g, '-');
                  const baseName = `Report_${ts}`;
                  const contentToExport = finalAnalysisResult || latestDraft;

                  try {
                    if (item.value === 'md') {
                      fs.writeFileSync(path.join(exportDir, `${baseName}.md`), contentToExport, 'utf8');
                      addLog(`Exported to dossiers/${baseName}.md`, 'success');
                    }
                    if (item.value === 'txt') {
                      fs.writeFileSync(path.join(exportDir, `${baseName}.txt`), contentToExport, 'utf8');
                      addLog(`Exported to dossiers/${baseName}.txt`, 'success');
                    }
                    if (item.value === 'json') {
                      fs.writeFileSync(path.join(exportDir, `${baseName}.json`), JSON.stringify({ target, result: contentToExport }), 'utf8');
                      addLog(`Exported to dossiers/${baseName}.json`, 'success');
                    }
                    if (item.value === 'clip') {
                      require('child_process').execSync('clip', { input: contentToExport });
                      addLog(`Copied to clipboard!`, 'success');
                    }
                  } catch (e: any) {
                    addLog(`Export failed: ${e.message}`, 'error');
                  }
                }
              }} 
            />
          </Box>
        )}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" height="100%">
      {step === 'welcome' && <WelcomeStep />}
      {step === 'setup' && <SetupStep />}
      {step === 'intelligence_keys' && <IntelligenceKeysStep />}
      {step === 'config' && <ConfigStep />}
      {step === 'audit' && <AuditStep />}
    </Box>
  );
};

render(<App />);
