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
import chalk from 'chalk';
import gradient from 'gradient-string';
import { logger } from '../src/runtime/logger';
import configManager, { ProviderProfile } from '../src/config/configManager';
import keyPool from '../src/providers/keyPool';

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
  type: 'system' | 'intelligence' | 'error' | 'success' | 'tool';
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
  const [latestDraft, setLatestDraft] = useState<any>(null);
  const [thoughts, setThoughts] = useState<string[]>([]);
  const [turn, setTurn] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStartingMission, setIsStartingMission] = useState(false);

  const [provider, setProvider] = useState(process.env.DEFAULT_PROVIDER || 'kilocode');
  const [model, setModel] = useState('');
  const [profileName, setProfileName] = useState('Default');

  const [isLabMode, setIsLabMode] = useState(false);
  const [tempTarget, setTempTarget] = useState('');
  const [tempGoal, setTempGoal] = useState('');

  const pendingLogsRef = useRef<MissionLog[]>([]);
  const activeRevealRef = useRef<{ log: MissionLog; cursor: number } | null>(null);

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
    if (activeProfile) {
      setProvider(activeProfile.provider);
      setModel(activeProfile.model || '');
      setProfileName(activeProfile.name);
    }
  }, [step]);

  useInput((input, key) => {
    if (key.escape) {
      if (step === 'setup' || step === 'config' || step === 'intelligence_keys') {
        setStep('welcome');
      } else if (step === 'audit' || step === 'report') {
        setStep('setup');
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

      const response = await fetch(`${DEFAULT_BASE_URL}/api/agent/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalArgs)
      });

      if (!response.ok) throw new Error(`Server returned ${response.status}`);
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
              if (data.log.includes('[Tool Call]')) type = 'tool';
              if (data.log.includes('[Error]')) type = 'error';
              addLog(data.log, type);
            }
            if (data.chunk) setFinalAnalysisResult(prev => prev + data.chunk);
            if (data.thought) setThoughts(prev => [...prev, data.thought]);
            if (data.draft) setLatestDraft(data.draft);
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
      else if (item.value === 'exit') { exit(); }
    };

    const logo = `
▄▄▄▄▄▄▄    ▄▄▄▄▄▄▄ ▄▄▄▄▄▄   ▄▄▄        ▄▄▄▄▄    ▄▄▄▄▄▄▄ ▄▄▄   ▄▄▄ 
███▀▀███▄ ███▀▀▀▀▀ ███▀▀██▄ ███      ▄███████▄ ███▀▀▀▀▀ ███ ▄███▀ 
███▄▄███▀ ███▄▄    ███  ███ ███      ███   ███ ███      ███████   
███▀▀██▄  ███      ███  ███ ███      ███▄▄▄███ ███      ███▀███▄  
███  ▀███ ▀███████ ██████▀  ████████  ▀█████▀  ▀███████ ███  ▀███  
    `;

    return (
      <Box flexDirection="column" padding={1}>
        <Gradient colors={["#D97757", "#FCAB64", "#D97757"]}><Text bold>{logo}</Text></Gradient>
        <Box marginTop={1}><SelectInput items={menuItems} onSelect={handleSelect} /></Box>
        <Spacer />
        <Box marginTop={1}><Text color={THEME.dim}>Active: {profileName} [{provider}]</Text></Box>
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
        <Text bold color={THEME.primary}>INTELLIGENCE KEYS</Text>
        <Box marginTop={1} flexDirection="column">
          <Box borderStyle="round" borderColor={focus === 'tavily' ? THEME.accent : THEME.dim} paddingX={1}>
            <Text>TAVILY KEY: </Text><TextInput value={tavily} onChange={setTavily} focus={focus === 'tavily'} mask="*" />
          </Box>
          <Box borderStyle="round" borderColor={focus === 'brave' ? THEME.accent : THEME.dim} paddingX={1}>
            <Text>BRAVE KEY : </Text><TextInput value={brave} onChange={setBrave} focus={focus === 'brave'} mask="*" />
          </Box>
        </Box>
        <Box marginTop={1}><Text color={THEME.accent}>[Enter to Save | Esc to Back]</Text></Box>
      </Box>
    );
  };

  const ConfigStep = () => {
    const [subStep, setSubStep] = useState<'list' | 'edit'>('list');
    const [selectedProfile, setSelectedProfile] = useState<any>(null);
    const profiles = configManager.getProfiles();
    const items = profiles.map(p => ({ label: p.id === configManager.getActiveProfile()?.id ? `◈ ${p.name}` : `  ${p.name}`, value: p.id }));

    const handleSelect = (item: any) => {
      const p = profiles.find(x => x.id === item.value);
      if (p) { setSelectedProfile({ ...p }); setSubStep('edit'); }
    };

    const save = () => { if (selectedProfile) { configManager.saveProfile(selectedProfile); configManager.setActiveProfile(selectedProfile.id); setStep('welcome'); } };
    const remove = () => { if (selectedProfile) { configManager.removeProfile(selectedProfile.id); setSubStep('list'); } };

    useInput((i, k) => {
      if (subStep === 'edit') {
        if (k.return) save();
        if (i === 'd') remove();
      }
    });

    if (subStep === 'edit' && selectedProfile) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold color={THEME.primary}>EDIT PROFILE: {selectedProfile.name}</Text>
          <Box flexDirection="column" marginTop={1}>
            <Box><Text>Name    : </Text><TextInput value={selectedProfile.name} onChange={v => setSelectedProfile({...selectedProfile, name: v})} /></Box>
            <Box><Text>Provider: </Text><TextInput value={selectedProfile.provider} onChange={v => setSelectedProfile({...selectedProfile, provider: v})} /></Box>
            <Box><Text>API Key : </Text><TextInput value={selectedProfile.apiKey || ''} onChange={v => setSelectedProfile({...selectedProfile, apiKey: v})} mask="*" /></Box>
            <Box><Text>Model   : </Text><TextInput value={selectedProfile.model || ''} onChange={v => setSelectedProfile({...selectedProfile, model: v})} /></Box>
          </Box>
          <Box marginTop={1}><Text color={THEME.accent}>[Enter to Save | D to Delete | Esc to Back]</Text></Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={THEME.primary}>PROFILE MANAGEMENT</Text>
        <Box marginTop={1}><SelectInput items={items} onSelect={handleSelect} /></Box>
        <Box marginTop={1}><Text color={THEME.accent}>[Select Profile to Edit/Activate | Esc to Back]</Text></Box>
      </Box>
    );
  };

  const AuditStep = () => (
    <Box flexDirection="column" padding={1}>
      <Text bold color={THEME.accent}>MISSION IN PROGRESS: {target}</Text>
      <Box flexDirection="column" marginTop={1} height={15} borderStyle="single" borderColor={THEME.dim}>
        {logs.slice(-14).map(log => (
          <Text key={log.id} color={log.type === 'error' ? THEME.error : log.type === 'success' ? THEME.accent : 'white'}>
            [{log.timestamp}] {log.message}
          </Text>
        ))}
        {streamingLog && <Text color={THEME.secondary}>[{streamingLog.timestamp}] {streamingLog.message}_</Text>}
      </Box>
      {missionComplete && <Box marginTop={1}><Text color={THEME.primary}>MISSION COMPLETE. [Press Esc to return]</Text></Box>}
    </Box>
  );

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
