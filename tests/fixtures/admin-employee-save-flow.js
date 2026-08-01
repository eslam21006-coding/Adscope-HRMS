      let employeeId;
      try {
        if (isNew) {
          const insertPayload = { ...common, compensation_type:fd.get('compensation_type'), basic_salary:num(fd.get('basic_salary')), payroll_currency:fd.get('payroll_currency'), default_commission_rate:num(fd.get('default_commission_rate')), attendance_required:fd.get('attendance_required') === 'true', current_shift_id:null };
          const { data, error } = await client.from('employees').insert(insertPayload).select('id').single();
          if (error) throw error;
          employeeId = data.id;
        } else {
          const { error } = await client.from('employees').update(common).eq('id',employee.id).eq('organization_id',orgId());
          if (error) throw error;
          employeeId = employee.id;
        }
        const selectedShift = fd.get('current_shift_id') || null;
        if (selectedShift && (isNew || selectedShift !== employee?.current_shift_id)) {
          const { error } = await client.rpc('assign_employee_shift',{ p_employee_id:employeeId,p_shift_id:selectedShift,p_effective_from:fd.get('shift_effective_from'),p_reason:'Assigned through Adscope HRMS' });
          if (error) throw error;
        }
        const compensationChanged = isNew || [
          String(fd.get('compensation_type')) !== String(employee?.compensation_type),
          num(fd.get('basic_salary')) !== num(employee?.basic_salary),
          String(fd.get('payroll_currency')) !== String(employee?.payroll_currency),
          num(fd.get('default_commission_rate')) !== num(employee?.default_commission_rate),
          (fd.get('attendance_required') === 'true') !== Boolean(employee?.attendance_required)
        ].some(Boolean);
        if (compensationChanged) {
          const { error } = await client.rpc('set_employee_compensation',{ p_employee_id:employeeId,p_compensation_type:fd.get('compensation_type'),p_basic_salary:num(fd.get('basic_salary')),p_currency:fd.get('payroll_currency'),p_default_commission_rate:num(fd.get('default_commission_rate')),p_attendance_required:fd.get('attendance_required') === 'true',p_effective_from:fd.get('comp_effective_from'),p_reason:'Updated through Adscope HRMS' });
          if (error) throw error;
        }
        if (isNew && fd.get('send_invite') === 'true') {
