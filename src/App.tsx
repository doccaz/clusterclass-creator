import React, { useState, useMemo, useEffect } from 'react';
import * as yaml from 'js-yaml';
import { 
  Layout, 
  Settings, 
  Cpu, 
  Globe, 
  Copy, 
  Check, 
  FileCode, 
  Server, 
  ShieldCheck, 
  Network,
  Terminal,
  Upload,
  Info,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  Trash2,
  Code
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---
interface ClusterConfig {
  clusterName: string;
  region: string;
  kubernetesVersion: string;
  instanceType: string;
  sshKey: string;
  namespace: string;
  cloudCredential: string;
  infraVersion: string;
}

interface ValidationLog {
  id: string;
  message: string;
  status: 'success' | 'warning' | 'info';
}

// --- Helper: Simple YAML Syntax Highlighter ---
const YamlHighlight = ({ code }: { code: string }) => {
  if (!code.trim()) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-600 space-y-4 py-20">
        <FileCode className="w-12 h-12 opacity-20" />
        <p className="text-sm font-mono italic">Waiting for YAML input...</p>
      </div>
    );
  }

  const lines = code.split('\n');
  
  return (
    <pre className="font-mono text-sm leading-relaxed overflow-x-auto p-4 bg-zinc-950 rounded-lg border border-zinc-800">
      {lines.map((line, i) => {
        let content: React.ReactNode = line;
        
        if (line.trim().startsWith('#')) {
          content = <span className="text-zinc-500 italic">{line}</span>;
        } else if (line.includes(':')) {
          const [key, ...rest] = line.split(':');
          const value = rest.join(':');
          content = (
            <>
              <span className="text-blue-400">{key}</span>
              <span className="text-zinc-400">:</span>
              <span className="text-emerald-400">{value}</span>
            </>
          );
        }

        return (
          <div key={i} className="min-h-[1.25rem]">
            {content}
          </div>
        );
      })}
    </pre>
  );
};

export default function App() {
  const [inputYaml, setInputYaml] = useState('');
  const [copied, setCopied] = useState(false);
  const [turtlesCheck, setTurtlesCheck] = useState<{ status: 'idle' | 'success' | 'warning', message: string }>({ status: 'idle', message: '' });
  const [validationLogs, setValidationLogs] = useState<ValidationLog[]>([]);
  
  const [config, setConfig] = useState<ClusterConfig>({
    clusterName: 'my-eks-test',
    region: 'us-east-1',
    kubernetesVersion: '1.31.0',
    instanceType: 't3.medium',
    sshKey: 'default-key',
    namespace: 'default',
    cloudCredential: 'aws-creds',
    infraVersion: 'v2.9.1'
  });

  // --- Transformation Engine ---
  const transformYaml = (input: string, targetNamespace: string, cloudCred: string, infraVer: string) => {
    if (!input.trim()) return { output: '', logs: [] as ValidationLog[] };

    const logs: ValidationLog[] = [];
    const versionSuffix = '-v1';
    const safeInfraVer = infraVer.startsWith('v') ? infraVer : `v${infraVer}`;
    
    // Version formatting helpers
    const toFullSemver = (v: string) => {
      const clean = v.replace(/^v/, '');
      const parts = clean.split('.');
      while (parts.length < 3) parts.push('0');
      return `v${parts.slice(0, 3).join('.')}`;
    };

    const toMajorMinor = (v: string) => {
      const clean = v.replace(/^v/, '');
      const parts = clean.split('.');
      if (parts.length < 2) parts.push('0');
      return `v${parts[0]}.${parts[1]}`;
    };

    try {
      const docs = yaml.loadAll(input) as any[];
      const templates: any[] = [];
      let clusterName = 'standard-cluster';
      let infrastructureRef: any = null;
      let controlPlaneRef: any = null;
      let hasEKSControlPlane = false;

      // First pass: identify cluster name
      docs.forEach(doc => {
        if (!doc || !doc.kind) return;
        if (doc.kind === 'Cluster') clusterName = doc.metadata.name;
      });

      docs.forEach((doc) => {
        if (!doc || !doc.kind) return;

        // Strip metadata
        if (doc.metadata) {
          delete doc.metadata.status;
          delete doc.metadata.uid;
          delete doc.metadata.resourceVersion;
          delete doc.metadata.creationTimestamp;
          delete doc.metadata.managedFields;
          
          // Implicit Namespace Handling
          doc.metadata.namespace = targetNamespace;
        }

        const kind = doc.kind;
        const apiVersion = doc.apiVersion || '';

        // API Version Enforcement
        if (apiVersion.includes('infrastructure.cluster.x-k8s.io')) doc.apiVersion = 'infrastructure.cluster.x-k8s.io/v1beta2';
        if (apiVersion.includes('controlplane.cluster.x-k8s.io')) doc.apiVersion = 'controlplane.cluster.x-k8s.io/v1beta2';
        if (apiVersion.includes('bootstrap.cluster.x-k8s.io')) doc.apiVersion = 'bootstrap.cluster.x-k8s.io/v1beta2';

        // 1. Identify Templates
        if (kind.endsWith('Template')) {
          // Standardized Naming Strategy
          if (kind === 'AWSMachineTemplate') {
            doc.metadata.name = `${clusterName}-node-group${versionSuffix}`;
          } else if (kind === 'EKSConfigTemplate') {
            doc.metadata.name = `${clusterName}-bootstrap${versionSuffix}`;
          } else {
            doc.metadata.name = `${doc.metadata.name}${versionSuffix}`;
          }
          templates.push(doc);
        } 
        // 2. Transform "Live" objects into Templates
        else if (kind === 'AWSManagedControlPlane') {
          hasEKSControlPlane = true;
          // Remove sshKeyName and roleName for EKS Managed Control Plane
          const cleanSpec = { ...doc.spec };
          delete cleanSpec.sshKeyName;
          delete cleanSpec.roleName;
          
          // Automatic IAM Logic: Add AmazonEKSClusterPolicy
          cleanSpec.roleAdditionalPolicies = [
            'arn:aws:iam::aws:policy/AmazonEKSClusterPolicy'
          ];
          
          // Versioning Rules: major.minor for EKS Control Plane
          if (cleanSpec.version) {
            cleanSpec.version = toMajorMinor(cleanSpec.version);
          }

          const template = {
            apiVersion: 'controlplane.cluster.x-k8s.io/v1beta2',
            kind: 'AWSManagedControlPlaneTemplate',
            metadata: {
              name: `${clusterName}-control-plane${versionSuffix}`,
              namespace: targetNamespace
            },
            spec: {
              template: {
                spec: cleanSpec
              }
            }
          };
          templates.push(template);
          controlPlaneRef = {
            apiVersion: 'controlplane.cluster.x-k8s.io/v1beta2',
            kind: 'AWSManagedControlPlaneTemplate',
            name: template.metadata.name
          };
        } else if (kind === 'AWSManagedCluster') {
          const template = {
            apiVersion: 'infrastructure.cluster.x-k8s.io/v1beta2',
            kind: 'AWSManagedClusterTemplate',
            metadata: {
              name: `${clusterName}-cluster${versionSuffix}`,
              namespace: targetNamespace
            },
            spec: {
              template: {
                spec: doc.spec
              }
            }
          };
          templates.push(template);
          infrastructureRef = {
            apiVersion: 'infrastructure.cluster.x-k8s.io/v1beta2',
            kind: 'AWSManagedClusterTemplate',
            name: template.metadata.name
          };
        }
      });

      logs.push({ id: 'version', message: 'API Version Alignment Successful (v1beta2 enforced)', status: 'success' });

      // 3. Generate ClusterClass
      const clusterClass: any = {
        apiVersion: 'cluster.x-k8s.io/v1beta1',
        kind: 'ClusterClass',
        metadata: {
          name: `${clusterName}-class${versionSuffix}`,
          namespace: targetNamespace,
          labels: {
            'cluster.x-k8s.io/managed-by': 'rancher'
          }
        },
        spec: {
          controlPlane: {
            ref: controlPlaneRef
          },
          infrastructure: {
            ref: infrastructureRef
          },
          workers: {
            machineDeployments: [
              {
                class: 'default-worker',
                template: {
                  bootstrap: {
                    ref: {
                      apiVersion: 'bootstrap.cluster.x-k8s.io/v1beta2',
                      kind: 'EKSConfigTemplate',
                      name: `${clusterName}-bootstrap${versionSuffix}`
                    }
                  },
                  infrastructure: {
                    ref: {
                      apiVersion: 'infrastructure.cluster.x-k8s.io/v1beta2',
                      kind: 'AWSMachineTemplate',
                      name: `${clusterName}-node-group${versionSuffix}`
                    }
                  }
                }
              }
            ]
          }
        }
      };

      // Remove Control Plane MachineTemplates for EKS
      if (hasEKSControlPlane) {
        delete clusterClass.spec.controlPlane.machineTemplate;
        delete clusterClass.spec.controlPlane.machineHealthChecks;
        logs.push({ id: 'eks-logic', message: 'EKS Special Logic applied: ControlPlane machineTemplate removed', status: 'info' });
        logs.push({ id: 'eks-cp', message: 'No Master MachineTemplates (Correct for EKS Managed Control Plane)', status: 'success' });
      }

      // 5. CAPIProvider for Turtles
      const capiProvider = {
        apiVersion: 'turtles-capi.cattle.io/v1alpha1',
        kind: 'CAPIProvider',
        metadata: {
          name: 'aws-provider',
          namespace: 'capi-providers'
        },
        spec: {
          name: 'aws',
          type: 'infrastructure',
          version: safeInfraVer,
          fetchConfig: {
            url: `https://github.com/kubernetes-sigs/cluster-api-provider-aws/releases/download/${safeInfraVer}/infrastructure-components.yaml`
          },
          variables: {
            EXP_EKS: "true",
            EXP_MACHINE_POOL: "true"
          },
          credentials: {
            rancherCloudCredential: cloudCred
          }
        }
      };

      // 6. RBAC Elevation for CAPA
      const rbacElevation = {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRoleBinding',
        metadata: {
          name: 'capa-manager-admin'
        },
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'ClusterRole',
          name: 'cluster-admin'
        },
        subjects: [
          {
            kind: 'ServiceAccount',
            name: 'capa-controller-manager',
            namespace: 'capi-providers'
          }
        ]
      };

      // 7. Cluster Object with Topology
      const clusterObject = {
        apiVersion: 'cluster.x-k8s.io/v1beta1',
        kind: 'Cluster',
        metadata: {
          name: clusterName,
          namespace: targetNamespace,
          labels: {
            'cluster.x-k8s.io/managed-by': 'rancher'
          }
        },
        spec: {
          clusterNetwork: {
            pods: {
              cidrBlocks: ['192.168.0.0/16']
            }
          },
          topology: {
            class: clusterClass.metadata.name,
            version: toFullSemver(config.kubernetesVersion),
            workers: {
              machineDeployments: [
                {
                  class: 'default-worker',
                  name: 'md-0',
                  replicas: 3
                }
              ]
            }
          }
        }
      };

      logs.push({ id: 'turtles-provider', message: `CAPIProvider configured for CAPA ${safeInfraVer} with EKS feature gates`, status: 'success' });
      logs.push({ id: 'rbac', message: 'RBAC Elevation ClusterRoleBinding generated', status: 'success' });
      logs.push({ id: 'cluster-obj', message: 'Cluster object with Rancher management labels generated', status: 'success' });
      logs.push({ id: 'ref-versions', message: 'RefVersionsUpToDate check: Pending (Apply templates first)', status: 'info' });

      const headerComment = `# Role: Senior Cloud-Native Architect (CAPI & Rancher Turtles)\n# Note: Templates are immutable. To update settings, you must create a new template name (e.g., -v2) and update the ClusterClass reference.\n# The ClusterClass will show an InternalError until the referenced template objects are actually applied to the cluster.\n\n`;
      const output = headerComment + [clusterObject, clusterClass, capiProvider, rbacElevation, ...templates].map(d => yaml.dump(d)).join('---\n');
      return { output, logs };
    } catch (e) {
      return { 
        output: `Error parsing YAML: ${e instanceof Error ? e.message : String(e)}`, 
        logs: [{ id: 'error', message: 'Parsing Failed', status: 'warning' }] as ValidationLog[]
      };
    }
  };

  const { output: transformedOutput, logs: currentLogs } = useMemo(() => 
    transformYaml(inputYaml, config.namespace, config.cloudCredential, config.infraVersion), 
  [inputYaml, config.namespace, config.cloudCredential, config.infraVersion, config.kubernetesVersion]);

  useEffect(() => {
    setValidationLogs(currentLogs);
  }, [currentLogs]);

  const handleCopy = () => {
    navigator.clipboard.writeText(transformedOutput);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const checkTurtlesCompatibility = () => {
    if (!inputYaml.trim()) {
      setTurtlesCheck({ status: 'warning', message: 'Please provide input YAML first.' });
      return;
    }

    const hasRancherLabel = transformedOutput.includes('cluster.x-k8s.io/managed-by: rancher');
    if (hasRancherLabel) {
      setTurtlesCheck({ status: 'success', message: 'Turtles Compatibility: Rancher management labels detected and applied!' });
    } else {
      setTurtlesCheck({ status: 'warning', message: 'Warning: Missing Rancher management labels. Ensure the Cluster resource has "cluster.x-k8s.io/managed-by: rancher".' });
    }
  };

  const commandSnippet = `AWS_NODE_MACHINE_TYPE="${config.instanceType}" AWS_REGION="${config.region}" AWS_SSH_KEY_NAME="${config.sshKey}" KUBERNETES_VERSION="${config.kubernetesVersion}" clusterctl generate cluster ${config.clusterName} --flavor eks --infrastructure aws:${config.infraVersion} > cluster-definition.yaml`;

  return (
    <div className="min-h-screen bg-[#141e26] text-zinc-100 font-sans selection:bg-blue-500/30 flex flex-col">
      {/* GitHub Ribbon */}
      <div className="fixed top-0 right-0 w-32 h-32 overflow-hidden pointer-events-none z-[100]">
        <a
          href="https://github.com/doccaz/clusterclass-creator"
          target="_blank"
          rel="noopener noreferrer"
          className="absolute top-0 right-0 block w-[150%] py-1.5 bg-[#0075a8] text-white text-[10px] font-bold text-center transform translate-x-[30%] translate-y-[40%] rotate-45 pointer-events-auto shadow-lg hover:bg-[#005a82] transition-colors border-y border-white/10 tracking-widest"
        >
          FORK ME ON GITHUB
        </a>
      </div>

      {/* Header */}
      <header className="border-b border-zinc-800 bg-[#1c2a35] backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 flex items-center justify-center bg-white rounded-lg p-1.5 shadow-lg shadow-white/5">
              <img 
                src="https://www.rancher.com/assets/img/logos/rancher-suse-logo-stacked-color.svg" 
                alt="Rancher Logo" 
                className="h-full w-auto object-contain"
                referrerPolicy="no-referrer"
              />
            </div>
            <div>
              <h1 className="font-bold text-lg tracking-tight">Rancher Turtles</h1>
              <p className="text-xs text-[#3d9970] font-mono font-semibold">CAPI-to-ClusterClass Converter</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={handleCopy}
              disabled={!transformedOutput.trim() || transformedOutput.startsWith('Error')}
              className="flex items-center gap-2 px-4 py-2 bg-[#0075a8] hover:bg-[#005a82] disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors text-sm font-medium border border-blue-400/20"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied!' : 'Export ClusterClass'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8 flex-grow">
        {/* Command Generator Section */}
        <section className="bg-[#1c2a35] border border-zinc-800 rounded-xl p-6 shadow-xl">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <Terminal className="w-5 h-5 text-[#0075a8]" />
              <h2 className="font-semibold text-zinc-200">1. Generate Base YAML</h2>
            </div>
            <div className="flex gap-4 flex-wrap">
               <div className="flex flex-col gap-1">
                 <span className="text-[10px] text-zinc-500 uppercase font-bold">Cluster Name</span>
                 <input 
                   value={config.clusterName} 
                   onChange={e => setConfig({...config, clusterName: e.target.value})}
                   className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:border-blue-500 outline-none w-28"
                 />
               </div>
               <div className="flex flex-col gap-1">
                 <span className="text-[10px] text-zinc-500 uppercase font-bold">Region</span>
                 <input 
                   value={config.region} 
                   onChange={e => setConfig({...config, region: e.target.value})}
                   className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:border-blue-500 outline-none w-24"
                 />
               </div>
               <div className="flex flex-col gap-1">
                 <span className="text-[10px] text-zinc-500 uppercase font-bold">Machine Type</span>
                 <input 
                   value={config.instanceType} 
                   onChange={e => setConfig({...config, instanceType: e.target.value})}
                   className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:border-blue-500 outline-none w-24"
                 />
               </div>
               <div className="flex flex-col gap-1">
                 <span className="text-[10px] text-zinc-500 uppercase font-bold">K8s Version</span>
                 <input 
                   value={config.kubernetesVersion} 
                   onChange={e => setConfig({...config, kubernetesVersion: e.target.value})}
                   className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:border-blue-500 outline-none w-24"
                 />
               </div>
               <div className="flex flex-col gap-1">
                 <span className="text-[10px] text-zinc-500 uppercase font-bold">Infra Version</span>
                 <input 
                   value={config.infraVersion} 
                   onChange={e => setConfig({...config, infraVersion: e.target.value})}
                   className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:border-blue-500 outline-none w-20"
                 />
               </div>
               <div className="flex flex-col gap-1">
                 <span className="text-[10px] text-zinc-500 uppercase font-bold">Namespace</span>
                 <input 
                   value={config.namespace} 
                   onChange={e => setConfig({...config, namespace: e.target.value})}
                   className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:border-blue-500 outline-none w-24"
                 />
               </div>
               <div className="flex flex-col gap-1">
                 <span className="text-[10px] text-zinc-500 uppercase font-bold">Cloud Credential</span>
                 <input 
                   value={config.cloudCredential} 
                   onChange={e => setConfig({...config, cloudCredential: e.target.value})}
                   className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:border-blue-500 outline-none w-28"
                 />
               </div>
            </div>
          </div>
          
          <div className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-[#0075a8] to-[#3d9970] rounded-lg blur opacity-25 group-hover:opacity-40 transition duration-1000 group-hover:duration-200"></div>
            <div className="relative p-4 bg-zinc-950 rounded-lg border border-zinc-800 flex items-center justify-between">
              <code className="text-[11px] text-blue-300 break-all leading-relaxed font-mono">
                {commandSnippet}
              </code>
              <button 
                onClick={() => navigator.clipboard.writeText(commandSnippet)}
                className="p-2 hover:bg-zinc-800 rounded-md transition-colors text-zinc-400 hover:text-white"
              >
                <Copy className="w-4 h-4" />
              </button>
            </div>
          </div>
        </section>

        {/* Converter Section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Left: Input */}
          <div className="flex flex-col space-y-4 h-[600px]">
            <div className="flex items-center justify-between px-2">
              <div className="flex items-center gap-2">
                <Upload className="w-4 h-4 text-zinc-400" />
                <span className="text-xs font-mono text-zinc-400 uppercase tracking-widest">Input: Raw clusterctl YAML</span>
              </div>
              <button 
                onClick={() => setInputYaml('')}
                className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1 transition-colors"
              >
                <Trash2 className="w-3 h-3" /> Clear
              </button>
            </div>
            <div className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden shadow-2xl relative">
              <textarea 
                value={inputYaml}
                onChange={(e) => setInputYaml(e.target.value)}
                className="w-full h-full bg-zinc-950 border-none p-6 focus:outline-none text-xs font-mono leading-relaxed resize-none custom-scrollbar text-zinc-300"
                placeholder="# Paste your clusterctl generate cluster output here..."
              />
            </div>
          </div>

          {/* Right: Output */}
          <div className="flex flex-col space-y-4 h-[600px]">
            <div className="flex items-center justify-between px-2">
              <div className="flex items-center gap-2">
                <Code className="w-4 h-4 text-[#3d9970]" />
                <span className="text-xs font-mono text-zinc-400 uppercase tracking-widest">Output: Standardized ClusterClass</span>
              </div>
              <div className="flex items-center gap-4">
                <button 
                  onClick={checkTurtlesCompatibility}
                  className="text-xs text-[#3d9970] hover:text-emerald-300 flex items-center gap-1 transition-colors font-semibold"
                >
                  <ShieldCheck className="w-3 h-3" /> Check Turtles Compatibility
                </button>
              </div>
            </div>
            <div className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden shadow-2xl flex flex-col">
              <div className="px-6 py-3 border-b border-zinc-800 flex items-center justify-between bg-[#1c2a35]">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/30" />
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-500/30" />
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/30" />
                </div>
                <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">turtles-clusterclass.yaml</span>
                {transformedOutput.includes('cluster.x-k8s.io/managed-by: rancher') && (
                  <div className="flex items-center gap-1 bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded text-[9px] font-bold border border-emerald-500/30">
                    <ShieldCheck className="w-3 h-3" />
                    TURTLES READY
                  </div>
                )}
              </div>
              <div className="flex-1 overflow-auto custom-scrollbar p-0">
                <YamlHighlight code={transformedOutput} />
              </div>
            </div>
            
            {/* Validation Log Panel */}
            <div className="space-y-4">
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 flex gap-3">
                <Info className="w-5 h-5 text-blue-400 shrink-0" />
                <div className="space-y-1">
                  <p className="text-[11px] font-bold text-blue-400 uppercase tracking-wider">Platform Note</p>
                  <p className="text-[11px] text-blue-200/70 leading-relaxed">
                    Templates are <span className="text-blue-300 font-bold underline decoration-blue-500/50">immutable</span>. To update settings, you must create a new template name (e.g., -v2) and update the ClusterClass reference. The ClusterClass will show an <span className="text-amber-400 font-mono">InternalError</span> until the referenced templates are applied.
                  </p>
                </div>
              </div>

              <div className="bg-[#1c2a35] border border-zinc-800 rounded-xl p-4 shadow-xl">
                <div className="flex items-center gap-2 mb-3">
                  <Info className="w-4 h-4 text-blue-400" />
                  <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Validation Log</h3>
                </div>
                <div className="space-y-2">
                  {validationLogs.length > 0 ? (
                    validationLogs.map(log => (
                      <div key={log.id} className="flex items-center gap-2 text-[11px] font-medium">
                        {log.status === 'success' ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                        ) : log.status === 'warning' ? (
                          <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
                        ) : (
                          <Info className="w-3.5 h-3.5 text-blue-500" />
                        )}
                        <span className={log.status === 'success' ? 'text-emerald-400/80' : log.status === 'warning' ? 'text-amber-400/80' : 'text-blue-400/80'}>
                          {log.message}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-[11px] text-zinc-600 italic">No logs available. Input YAML to begin validation.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Status Bar */}
        <AnimatePresence>
          {turtlesCheck.status !== 'idle' && (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className={`p-4 rounded-lg flex items-center gap-3 border ${
                turtlesCheck.status === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
              }`}
            >
              {turtlesCheck.status === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
              <span className="text-sm font-medium">{turtlesCheck.message}</span>
              <button onClick={() => setTurtlesCheck({ status: 'idle', message: '' })} className="ml-auto text-zinc-500 hover:text-zinc-300">
                <Trash2 className="w-4 h-4" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Debugging Playbook Section */}
      <section className="max-w-7xl mx-auto px-6 py-12 w-full border-t border-zinc-900/50">
        <div className="bg-[#1c2a35] border border-zinc-800 rounded-xl p-8 shadow-2xl">
            <div className="flex items-center gap-2 mb-6">
              <Terminal className="w-5 h-5 text-amber-500" />
              <h2 className="font-semibold text-zinc-200 uppercase tracking-wider text-sm">🛠️ Troubleshooting Tips: The Debugging Playbook</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-blue-400 uppercase">If ClusterClass shows InternalError</h3>
                <p className="text-[11px] text-zinc-400 leading-relaxed">Run "kubectl describe clusterclass [name] -n [ns]" to check for misspelled Template names or Namespace mismatches.</p>
                <code className="block p-2 bg-zinc-950 rounded border border-zinc-800 text-[10px] text-emerald-400 font-mono">
                  kubectl describe clusterclass [name] -n [ns]
                </code>
              </div>
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-blue-400 uppercase">If Provider shows Forbidden</h3>
                <p className="text-[11px] text-zinc-400 leading-relaxed">Run "kubectl logs -n capi-providers -l cluster.x-k8s.io/provider=infrastructure-aws" to check for missing RBAC for EKS API groups.</p>
                <code className="block p-2 bg-zinc-950 rounded border border-zinc-800 text-[10px] text-emerald-400 font-mono">
                  kubectl logs -n capi-providers -l cluster.x-k8s.io/provider=infrastructure-aws
                </code>
              </div>
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-blue-400 uppercase">If Topology shows ReconcileFailed</h3>
                <p className="text-[11px] text-zinc-400 leading-relaxed">Use "kubectl get cluster -o yaml" to check for the error "failed to create AWSManagedControlPlane". This usually means the ClusterClass is trying to define machines for the EKS control plane or using an invalid version format.</p>
                <code className="block p-2 bg-zinc-950 rounded border border-zinc-800 text-[10px] text-emerald-400 font-mono">
                  kubectl get cluster -o yaml -n [ns]
                </code>
              </div>
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-blue-400 uppercase">If Infrastructure stays Ready=False</h3>
                <p className="text-[11px] text-zinc-400 leading-relaxed">Run "kubectl describe awsmanagedcontrolplane -n [ns]" to see real-time AWS provisioning errors (e.g., IAM permission issues or VPC limit hits).</p>
                <code className="block p-2 bg-zinc-950 rounded border border-zinc-800 text-[10px] text-emerald-400 font-mono">
                  kubectl describe awsmanagedcontrolplane -n [ns]
                </code>
              </div>
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-blue-400 uppercase">If status shows observedGeneration 0</h3>
                <p className="text-[11px] text-zinc-400 leading-relaxed">See why the ClusterClass failed its initial validation pass.</p>
                <code className="block p-2 bg-zinc-950 rounded border border-zinc-800 text-[10px] text-emerald-400 font-mono">
                  kubectl logs -n cattle-capi-system -l control-plane=controller-manager
                </code>
              </div>
            </div>
          </div>
        </section>

        {/* Footer */}
      <footer className="w-full border-t border-zinc-900">
        <div className="max-w-7xl mx-auto px-6 py-12">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-4 text-zinc-500 text-sm">
              <img 
                src="https://www.rancher.com/assets/img/logos/rancher-suse-logo-stacked-color.svg" 
                alt="Rancher Logo" 
                className="h-8 w-auto opacity-70 hover:opacity-100 transition-opacity"
                referrerPolicy="no-referrer"
              />
              <span>Rancher Turtles Platform Engineering</span>
            </div>
            <div className="flex gap-8 text-xs font-mono text-zinc-600">
              <a 
                href="https://turtles.docs.rancher.com/turtles/stable/en/index.html" 
                target="_blank" 
                rel="noopener noreferrer"
                className="hover:text-zinc-400 transition-colors"
              >
                Documentation
              </a>
              <a 
                href="https://turtles.docs.rancher.com/turtles/stable/en/overview/certified.html" 
                target="_blank" 
                rel="noopener noreferrer"
                className="hover:text-zinc-400 transition-colors"
              >
                CAPI Providers
              </a>
              <a 
                href="https://rancher.com" 
                target="_blank" 
                rel="noopener noreferrer"
                className="hover:text-zinc-400 transition-colors"
              >
                More info
              </a>
            </div>
          </div>
        </div>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #2c3e50;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #34495e;
        }
      `}</style>
    </div>
  );
}
