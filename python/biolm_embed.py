"""Offline ESM2/ESMC/ProTrek embedding worker for a GPU host."""
import argparse, json, os, sys
from pathlib import Path
os.environ['HF_HUB_OFFLINE']='1'; os.environ['TRANSFORMERS_OFFLINE']='1'
import numpy as np
import torch

def main():
    p=argparse.ArgumentParser(); p.add_argument('--model',choices=['esm2','esmc','protrek'],required=True); p.add_argument('--root',required=True); p.add_argument('--input',required=True); p.add_argument('--output',required=True); p.add_argument('--device',default='cuda:0'); a=p.parse_args()
    root=Path(a.root).resolve(); sequences=json.loads(Path(a.input).read_text())
    if not sequences or any(not s or set(s)-set('ACDEFGHIKLMNPQRSTVWYXBZUO') for s in sequences): raise ValueError('Expected nonempty amino-acid sequences')
    if a.model=='esm2':
        from transformers import AutoTokenizer, EsmModel
        weights=root/'models/esm2_t33_650M_UR50D_t0'; tokenizer=AutoTokenizer.from_pretrained(weights,local_files_only=True); model=EsmModel.from_pretrained(weights,local_files_only=True).eval().to(a.device)
        def embed(s):
            tokens=tokenizer(s,return_tensors='pt').to(a.device); return model(**tokens).last_hidden_state[:,1:-1].float().mean(1)
    elif a.model=='esmc':
        from esm.models.esmc import ESMC
        from esm.sdk.api import ESMProtein, LogitsConfig
        from esm.tokenization import get_esmc_model_tokenizers
        model=ESMC(d_model=1152,n_heads=18,n_layers=36,tokenizer=get_esmc_model_tokenizers(),use_flash_attn=False).eval(); checkpoint=root/'models/esmc-600m-2024-12-t0/data/weights/esmc_600m_2024_12_v0.pth'; model.load_state_dict(torch.load(checkpoint,map_location='cpu',weights_only=True),strict=True); model.to(device=a.device,dtype=torch.bfloat16)
        def embed(s):
            out=model.logits(model.encode(ESMProtein(sequence=s)),LogitsConfig(sequence=False,return_embeddings=True)); return out.embeddings[:,1:-1].float().mean(1)
    else:
        source=root/'src/ProTrek-t0'; os.chdir(source); sys.path.insert(0,str(source)); from model.ProTrek.protrek_trimodal_model import ProTrekTrimodalModel
        weights=root/'models/ProTrek_650M_t0'; model=ProTrekTrimodalModel(protein_config=str(weights/'esm2_t33_650M_UR50D'),text_config=str(weights/'BiomedNLP-PubMedBERT-base-uncased-abstract-fulltext'),structure_config=str(weights/'foldseek_t30_150M'),load_protein_pretrained=False,load_text_pretrained=False,from_checkpoint=str(weights/'ProTrek_650M.pt')).eval().to(a.device)
        def embed(s): return model.get_protein_repr([s],batch_size=1).float()
    rows=[]
    with torch.inference_mode():
        for sequence in sequences:
            chunks=[sequence[i:i+1022] for i in range(0,len(sequence),1022)]
            vector=sum(embed(s)*len(s) for s in chunks)/len(sequence); vector=torch.nn.functional.normalize(vector,dim=-1)
            if not torch.isfinite(vector).all(): raise ValueError('Nonfinite embedding')
            rows.append(vector.cpu().numpy()[0])
    np.save(a.output,np.stack(rows).astype('float32'),allow_pickle=False)
if __name__=='__main__': main()
